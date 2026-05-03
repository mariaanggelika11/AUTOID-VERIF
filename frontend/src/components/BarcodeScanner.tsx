import { useEffect, useRef, useState } from 'react';
import { submitBarcode } from '../services/api';
import { useAppStore } from '../store/useAppStore';
import { getErrorMessage } from '../utils/helpers';
import { createUploadPdf417Reader, type ScanResult, type ScannerSession, startPdf417Scanner } from '../utils/pdf417Scanner';
import { Button } from './ui/Button';

export default function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<ScannerSession | null>(null);
  const submittingRef = useRef(false);
  const uploadReaderRef = useRef(createUploadPdf417Reader());
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
  const [capturedPreview, setCapturedPreview] = useState('');
  const [manualRaw, setManualRaw] = useState('');

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
      setCapturedPreview(barcodeCaptureImage);
      setStatus('Opening camera...');

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
  }, [barcodeCaptureImage, cameraListReady, deviceId, restartKey]);

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
    setRestartKey((current) => current + 1);
  }

  async function toggleTorch() {
    const next = !torchEnabled;
    await sessionRef.current?.setTorch(next);
    setTorchEnabled(next);
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
      const result = await uploadReaderRef.current.decodeFromImageUrl(url);
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

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-md bg-gray-100">
        <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 bg-black/20">
          <div className="absolute left-1/2 top-1/2 h-[78%] w-[96%] -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-white shadow-[0_0_0_999px_rgba(0,0,0,0.3)]" />
          <p className="absolute left-1/2 top-[14%] -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
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

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        {devices.length > 0 && (
          <label className="block text-sm font-medium text-gray-700">
            Camera
            <select
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-950"
              value={deviceId ?? ''}
              onChange={(event) => setDeviceId(event.target.value)}
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
            Retry Scan
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
