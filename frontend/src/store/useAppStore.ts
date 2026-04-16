import { create } from 'zustand';
import type { FaceResult, LicenseData } from '../services/api';

type Step = 'barcode' | 'front' | 'result';

type AppState = {
  step: Step;
  license: LicenseData | null;
  faceResult: FaceResult | null;
  barcodeRaw: string;
  croppedFaceImage: string;
  goToStep: (step: Step) => void;
  setLicense: (license: LicenseData, raw: string) => void;
  setFaceResult: (result: FaceResult, croppedFaceImage: string) => void;
  reset: () => void;
};

export const useAppStore = create<AppState>((set) => ({
  step: 'barcode',
  license: null,
  faceResult: null,
  barcodeRaw: '',
  croppedFaceImage: '',
  goToStep: (step) => set((state) => {
    if (step === 'front' && !state.license) return state;
    if (step === 'result' && !state.faceResult) return state;
    return { step };
  }),
  setLicense: (license, barcodeRaw) => set({ license, barcodeRaw, step: 'front' }),
  setFaceResult: (faceResult, croppedFaceImage) => set({ faceResult, croppedFaceImage, step: 'result' }),
  reset: () => set({ step: 'barcode', license: null, faceResult: null, barcodeRaw: '', croppedFaceImage: '' })
}));
