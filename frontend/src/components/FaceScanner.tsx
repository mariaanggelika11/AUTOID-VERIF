import * as faceapi from 'face-api.js';
import { useEffect, useRef, useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { submitCardFace } from '../services/api';
import { useAppStore } from '../store/useAppStore';
import { getErrorMessage } from '../utils/helpers';
import { Button } from './ui/Button';

let modelsReady = false;

async function loadModels() {
  if (modelsReady) return;

  const manifest = await fetch('/models/tiny_face_detector_model-weights_manifest.json', {
    cache: 'no-store'
  });

  const contentType = manifest.headers.get('content-type') ?? '';
  if (!manifest.ok || !contentType.includes('application/json')) {
    throw new Error(
      'Face detector model is missing. Put tiny_face_detector model files in frontend/public/models, then refresh the page.'
    );
  }

  await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
  modelsReady = true;
}

function cropFace(video: HTMLVideoElement, box: faceapi.Box) {
  const padding = 0.25;
  const sx = Math.max(0, box.x - box.width * padding);
  const sy = Math.max(0, box.y - box.height * padding);
  const sw = Math.min(video.videoWidth - sx, box.width * (1 + padding * 2));
  const sh = Math.min(video.videoHeight - sy, box.height * (1 + padding * 2));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');

  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export default function FaceScanner() {
  const { videoRef, ready, start, stop } = useCamera();
  const setFaceResult = useAppStore((state) => state.setFaceResult);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Starting camera...');

  useEffect(() => {
    start()
      .then(() => setStatus('Place the Driver License front in the frame. Use the face printed on the card.'))
      .catch((err) => setError(getErrorMessage(err)));
  }, [start]);

  async function captureCardFace() {
    setError('');
    setStatus('Loading face detector model...');
    setLoading(true);

    try {
      await loadModels();

      const video = videoRef.current;
      if (!video) throw new Error('Camera is not ready');

      setStatus('Detecting face on the Driver License card...');
      const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions());
      if (!detections.length) {
        throw new Error('No face detected on the Driver License. Move closer, reduce glare, and keep the card sharp.');
      }

      const face = detections.sort((a, b) => b.box.area - a.box.area)[0];
      const image = cropFace(video, face.box);
      setStatus('Face cropped from card. Comparing with dataset...');
      const result = await submitCardFace(image);

      stop();
      setFaceResult(result, image);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <video ref={videoRef} className="aspect-video w-full rounded-md bg-gray-100 object-cover" muted playsInline />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 hidden h-full w-full" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={captureCardFace} disabled={!ready || loading}>
          {loading ? 'Checking...' : 'Scan DL Front'}
        </Button>
        <span className="text-sm text-gray-600">Use the Driver License front. Do not scan a selfie.</span>
      </div>
      {status && <p className="text-sm text-gray-600">{status}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
