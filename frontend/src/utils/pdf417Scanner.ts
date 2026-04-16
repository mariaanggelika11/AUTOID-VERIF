import { BarcodeFormat, BrowserCodeReader, BrowserMultiFormatReader } from '@zxing/browser';
import { ChecksumException, DecodeHintType, FormatException, NotFoundException } from '@zxing/library';

export type ScanQuality = {
  attempts: number;
  brightness: number;
  blurScore: number;
  message: string;
};

type ScannerOptions = {
  video: HTMLVideoElement;
  deviceId?: string;
  onResult: (raw: string) => void;
  onQuality: (quality: ScanQuality) => void;
  onError: (message: string) => void;
};

export type ScannerSession = {
  stop: () => void;
  setTorch: (enabled: boolean) => Promise<void>;
  torchSupported: boolean;
};

const SCAN_INTERVAL_MS = 400;
const MIN_FAIL_ATTEMPTS = 10;
const ROI_WIDTH_RATIO = 0.82;
const ROI_HEIGHT_RATIO = 0.42;

const hints = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
  [DecodeHintType.TRY_HARDER, true]
]);

const reader = new BrowserMultiFormatReader(hints);

function getCameraConstraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { min: 1280, ideal: 1920 },
    height: { min: 720, ideal: 1080 },
    facingMode: { ideal: 'environment' }
  };

  if (deviceId) {
    video.deviceId = { exact: deviceId };
  }

  return {
    audio: false,
    video
  };
}

async function applyCameraControls(stream: MediaStream) {
  const [track] = stream.getVideoTracks();
  if (!track) return;

  const constraints = {
    advanced: [
      { focusMode: 'continuous' },
      { exposureMode: 'continuous' },
      { whiteBalanceMode: 'continuous' }
    ]
  } as unknown as MediaTrackConstraints;

  await track.applyConstraints(constraints).catch(() => undefined);
}

function getRoi(video: HTMLVideoElement) {
  const width = Math.round(video.videoWidth * ROI_WIDTH_RATIO);
  const height = Math.round(video.videoHeight * ROI_HEIGHT_RATIO);
  const x = Math.round((video.videoWidth - width) / 2);
  const y = Math.round((video.videoHeight - height) / 2);

  return { x, y, width, height };
}

function getAverageBrightness(gray: Uint8ClampedArray) {
  let sum = 0;
  for (let index = 0; index < gray.length; index += 1) sum += gray[index];
  return sum / gray.length;
}

function getBlurScore(gray: Uint8ClampedArray, width: number, height: number) {
  let total = 0;
  let totalSquared = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const index = y * width + x;
      const laplacian =
        gray[index - width] +
        gray[index - 1] -
        gray[index] * 4 +
        gray[index + 1] +
        gray[index + width];

      total += laplacian;
      totalSquared += laplacian * laplacian;
      count += 1;
    }
  }

  if (!count) return 0;
  const mean = total / count;
  return totalSquared / count - mean * mean;
}

function preprocess(source: HTMLCanvasElement, adaptiveThreshold = false) {
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas context is not available.');

  const image = context.getImageData(0, 0, source.width, source.height);
  const { data } = image;
  const gray = new Uint8ClampedArray(source.width * source.height);

  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    gray[pixel] = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
  }

  const brightness = getAverageBrightness(gray);
  const blurScore = getBlurScore(gray, source.width, source.height);
  const enhanced = new Uint8ClampedArray(gray.length);
  const contrast = 1.45;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const index = y * source.width + x;
      const center = gray[index];
      const left = gray[index - 1] ?? center;
      const right = gray[index + 1] ?? center;
      const top = gray[index - source.width] ?? center;
      const bottom = gray[index + source.width] ?? center;
      const sharpened = center * 1.8 - (left + right + top + bottom) * 0.2;
      const contrasted = (sharpened - 128) * contrast + 128;
      enhanced[index] = Math.max(0, Math.min(255, contrasted));
    }
  }

  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    const value = adaptiveThreshold ? (enhanced[pixel] > brightness * 0.92 ? 255 : 0) : enhanced[pixel];
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(image, 0, 0);
  return { brightness, blurScore };
}

function getQualityMessage(attempts: number, brightness: number, blurScore: number, error: unknown) {
  if (brightness < 65) return 'Low light detected';
  if (blurScore < 90) return 'Hold steady';

  if (error instanceof ChecksumException) {
    return 'Hold steady';
  }

  if (error instanceof FormatException) {
    return 'Barcode is visible but not valid PDF417';
  }

  if (attempts >= MIN_FAIL_ATTEMPTS) {
    return 'Barcode not found';
  }

  return 'Move closer';
}

function drawRoiToCanvas(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const roi = getRoi(video);
  const targetWidth = Math.min(1100, roi.width);
  const targetHeight = Math.round((targetWidth / roi.width) * roi.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas context is not available.');

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  context.drawImage(video, roi.x, roi.y, roi.width, roi.height, 0, 0, targetWidth, targetHeight);
}

function isAamva(raw: string) {
  return raw.includes('ANSI') || raw.includes('AAMVA');
}

export async function startPdf417Scanner(options: ScannerOptions): Promise<ScannerSession> {
  const stream = await navigator.mediaDevices.getUserMedia(getCameraConstraints(options.deviceId));
  try {
    await applyCameraControls(stream);

    options.video.srcObject = stream;
    options.video.muted = true;
    options.video.playsInline = true;
    await options.video.play();
  } catch (error) {
    stream.getTracks().forEach((item) => item.stop());
    BrowserCodeReader.cleanVideoSource(options.video);
    throw error;
  }

  const [track] = stream.getVideoTracks();
  const torchSupported = Boolean(track && BrowserCodeReader.mediaStreamIsTorchCompatibleTrack(track));
  const canvas = document.createElement('canvas');
  let stopped = false;
  let attempts = 0;

  const scanOnce = () => {
    if (stopped || options.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    attempts += 1;
    let brightness = 0;
    let blurScore = 0;

    try {
      drawRoiToCanvas(options.video, canvas);
      const quality = preprocess(canvas);
      brightness = quality.brightness;
      blurScore = quality.blurScore;

      let result;
      try {
        result = reader.decodeFromCanvas(canvas);
      } catch (firstError) {
        if (firstError instanceof NotFoundException && attempts >= 3) {
          preprocess(canvas, true);
          result = reader.decodeFromCanvas(canvas);
        } else {
          throw firstError;
        }
      }

      const raw = result.getText();
      if (!isAamva(raw)) {
        options.onError('Barcode is not a US Driver License');
        options.onQuality({ attempts, brightness, blurScore, message: 'Barcode is not a US Driver License' });
        return;
      }

      stopped = true;
      options.onQuality({ attempts, brightness, blurScore, message: 'PDF417 detected' });
      options.onResult(raw);
    } catch (error) {
      options.onQuality({
        attempts,
        brightness,
        blurScore,
        message: getQualityMessage(attempts, brightness, blurScore, error)
      });
    }
  };

  const intervalId = window.setInterval(scanOnce, SCAN_INTERVAL_MS);

  return {
    torchSupported,
    stop: () => {
      stopped = true;
      window.clearInterval(intervalId);
      stream.getTracks().forEach((item) => item.stop());
      BrowserCodeReader.cleanVideoSource(options.video);
    },
    setTorch: async (enabled: boolean) => {
      if (!track || !torchSupported) return;
      await BrowserCodeReader.mediaStreamSetTorch(track, enabled);
    }
  };
}
