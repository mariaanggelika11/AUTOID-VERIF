import { useEffect, useRef, useState } from 'react';
import { submitBarcode } from '../services/api';
import { useAppStore } from '../store/useAppStore';
import { getErrorMessage } from '../utils/helpers';
import {
  capturePdf417AttemptFromBurstWithLockedPreview,
  capturePdf417HighResStill,
  capturePdf417Preview,
  capturePdf417UiPreview,
  createUploadPdf417Reader,
  decodeCapturedFrameHybrid,
  type ScanResult,
  type ScannerSession,
  startPdf417Scanner
} from '../utils/pdf417Scanner';
import { Button } from './ui/Button';

export default function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<ScannerSession | null>(null);
  const submittingRef = useRef(false);
  const lastQualityUiUpdateRef = useRef(0);
  const cameraPickerActiveRef = useRef(false);
  const cameraSwitchingRef = useRef(false);
  const setLicense = useAppStore((state) => state.setLicense);
  const barcodeCaptureImage = useAppStore((state) => state.barcodeCaptureImage);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [restartKey, setRestartKey] = useState(0);
  const [cameraListReady, setCameraListReady] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Opening camera...');
  const [capturedPreview, setCapturedPreview] = useState(() => barcodeCaptureImage);
  const [manualCapturing, setManualCapturing] = useState(false);
  const [manualRaw, setManualRaw] = useState('');

  function waitForNextPaint() {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Failed to read the uploaded image.'));
      reader.readAsDataURL(file);
    });
  }

  useEffect(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((items) => {
        const cameras = items.filter((item): item is MediaDeviceInfo => item.kind === 'videoinput');
        setDevices(cameras);
        setDeviceId((current) => current ?? cameras.find((item) => /back|rear|environment/i.test(item.label))?.deviceId ?? cameras[0]?.deviceId);
        setCameraListReady(true);
      })
      .catch(() => setCameraListReady(true));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!cameraListReady || !videoRef.current) return;

      sessionRef.current?.stop();
      sessionRef.current = null;
      submittingRef.current = false;
      setScanning(true);
      setError('');
      setAttempts(0);
      setTorchEnabled(false);
      setManualCapturing(false);
      setStatus('Opening camera...');
      lastQualityUiUpdateRef.current = 0;
      cameraPickerActiveRef.current = false;
      cameraSwitchingRef.current = false;

      try {
        const session = await startPdf417Scanner({
          video: videoRef.current,
          deviceId,
          onCapture: (captureImage) => {
            setScanning(false);
            setCapturedPreview(captureImage);
            setStatus('Preview captured. Parsing barcode...');
          },
          onResult: (result) => void handleBarcode(result),
          onError: (message) => setError(message),
          onQuality: (quality) => {
            const now = Date.now();
            const shouldRefreshUi =
              quality.message === 'Parsing barcode...' ||
              quality.attempts <= 2 ||
              now - lastQualityUiUpdateRef.current >= 350;

            if (!shouldRefreshUi) return;

            lastQualityUiUpdateRef.current = now;
            setAttempts(quality.attempts);
            setStatus(quality.message);
          }
        });

        if (cancelled) {
          session.stop();
          return;
        }

        sessionRef.current = session;
        setTorchSupported(session.torchSupported);
        setStatus('Place the full Driver License inside the box.');
      } catch (err) {
        if (cancelled) return;

        setScanning(false);
        setStatus('');
        setError(getErrorMessage(err));
      }
    }

    void start();

    return () => {
      cancelled = true;
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, [cameraListReady, deviceId, restartKey]);

  async function handleBarcode(result: ScanResult) {
    if (submittingRef.current) return;
    submittingRef.current = true;

    try {
      setCapturedPreview(result.captureImage);
      setScanning(false);
      setStatus('Parsing AAMVA data...');
      const license = await submitBarcode(result.raw);
      sessionRef.current?.stop();
      setLicense(license, result.raw, result.captureImage);
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus('Captured, but parsing failed.');
      setScanning(false);
    } finally {
      submittingRef.current = false;
    }
  }

  function retry() {
    setCapturedPreview('');
    setError('');
    setStatus('Opening camera...');
    setRestartKey((current) => current + 1);
  }

  async function toggleTorch() {
    const next = !torchEnabled;
    await sessionRef.current?.setTorch(next);
    setTorchEnabled(next);
  }

  function pauseScannerForCameraPicker() {
    if (cameraPickerActiveRef.current || manualCapturing || !sessionRef.current) return;
    cameraPickerActiveRef.current = true;
    sessionRef.current.pause();
    setScanning(false);
    setStatus('Choose a camera...');
  }

  function resumeScannerAfterCameraPicker() {
    if (!cameraPickerActiveRef.current) return;
    cameraPickerActiveRef.current = false;
    if (cameraSwitchingRef.current) return;
    if (!sessionRef.current || manualCapturing) return;
    sessionRef.current.resume();
    setScanning(true);
    setStatus('Place the full Driver License inside the box.');
  }

  function handleCameraChange(nextDeviceId: string) {
    cameraSwitchingRef.current = true;
    setScanning(false);
    setStatus('Opening camera...');
    setDeviceId(nextDeviceId);
  }

  async function scanUploadedImage(file: File | undefined) {
    if (!file) return;

    setError('');
    setCapturedPreview('');
    setStatus('Reading barcode from uploaded image...');

    const url = URL.createObjectURL(file);

    try {
      const preview = await readFileAsDataUrl(file);
      setCapturedPreview(preview);
      const result = await createUploadPdf417Reader().decodeFromImageUrl(url);
      await handleBarcode({ raw: result.getText(), captureImage: preview });
    } catch (err) {
      setError(`Barcode not found. ${getErrorMessage(err)}`);
      setStatus('');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function submitManualBarcode() {
    setError('');
    if (!manualRaw.trim()) {
      setError('Paste raw PDF417 text first.');
      return;
    }

    await handleBarcode({ raw: manualRaw.trim(), captureImage: '' });
  }

  async function captureBarcodeManually() {
    if (!videoRef.current || submittingRef.current || manualCapturing) return;

    setManualCapturing(true);
    sessionRef.current?.pause();
    const lockedPreviewImage = capturePdf417UiPreview(videoRef.current);
    setCapturedPreview(lockedPreviewImage);
    setScanning(false);
    setError('');
    setStatus('Preview captured. Preparing barcode...');
    try {
      await waitForNextPaint();
      const stillCapture = await capturePdf417HighResStill(videoRef.current);
      const initialCapture = stillCapture ?? capturePdf417Preview(videoRef.current, false);
      sessionRef.current?.stop();
      sessionRef.current = null;

      const attempt = await decodeCapturedFrameHybrid(initialCapture, 'manual', true)
        .then((result) => ({
          ok: true as const,
          result: {
            ...result.decoded,
            captureImage: lockedPreviewImage
          }
        }))
        .catch(() => capturePdf417AttemptFromBurstWithLockedPreview([initialCapture], lockedPreviewImage));

      if (!attempt.ok) {
        setCapturedPreview(attempt.error.captureImage);
        setStatus('Manual capture failed.');
        setError(attempt.error.message);
        return;
      }

      await handleBarcode(attempt.result);
    } finally {
      setManualCapturing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-md bg-gray-100">
        <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 bg-gray-500/12">
          <div className="absolute left-1/2 top-1/2 h-[78%] w-[96%] -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-white shadow-[0_0_0_999px_rgba(107,114,128,0.22)]" />
          <p className="absolute left-1/2 top-[14%] -translate-x-1/2 rounded-full bg-gray-700/70 px-3 py-1 text-xs font-medium text-white">
            Keep the full card inside the box
          </p>
        </div>
        <div className="absolute bottom-3 left-3 rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-950">
          {status || 'Scanning PDF417'}
        </div>
      </div>

      {capturedPreview && (
        <div className="rounded-md border border-gray-200 p-3">
          <p className="mb-2 text-sm font-medium text-gray-700">Captured barcode preview</p>
          <img src={capturedPreview} alt="Captured barcode preview" className="max-h-56 w-full rounded-md object-contain" />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        {devices.length > 0 && (
          <label className="block text-sm font-medium text-gray-700">
            Camera
            <select
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-950"
              value={deviceId ?? ''}
              onPointerDown={pauseScannerForCameraPicker}
              onFocus={pauseScannerForCameraPicker}
              onBlur={resumeScannerAfterCameraPicker}
              onChange={(event) => handleCameraChange(event.target.value)}
            >
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}

        {torchSupported && (
          <Button type="button" onClick={toggleTorch} className="self-end">
            {torchEnabled ? 'Torch Off' : 'Torch On'}
          </Button>
        )}

        <Button type="button" onClick={() => void captureBarcodeManually()} disabled={manualCapturing} className="self-end">
          {manualCapturing ? 'Capturing...' : 'Manual Capture'}
        </Button>
      </div>

      <div className="rounded-md border border-gray-200 p-3 text-sm text-gray-700">
        <p>Status: {status || '-'}</p>
        <p>Attempts: {attempts}</p>
        <p>Scanner: {scanning ? 'Active' : 'Stopped'}</p>
        <p>Flow: Capture first, then parse</p>
      </div>

      {error && (
        <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <Button type="button" onClick={retry}>
            Capture Again
          </Button>
        </div>
      )}

      <div className="border-t border-gray-200 pt-4">
        <label className="block text-sm font-medium text-gray-700">
          Upload barcode photo
          <input
            type="file"
            accept="image/*"
            className="mt-1 block w-full text-sm text-gray-600"
            onChange={(event) => void scanUploadedImage(event.target.files?.[0])}
          />
        </label>
      </div>

      <div className="space-y-2 border-t border-gray-200 pt-4">
        <label className="block text-sm font-medium text-gray-700">
          Manual PDF417 raw text
          <textarea
            className="mt-1 min-h-28 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-950"
            value={manualRaw}
            onChange={(event) => setManualRaw(event.target.value)}
            placeholder="Paste raw AAMVA/PDF417 text here for testing"
          />
        </label>
        <Button type="button" onClick={submitManualBarcode}>
          Parse Manual Barcode
        </Button>
      </div>
    </div>
  );
}
