import BarcodeScanner from '../components/BarcodeScanner';
import FaceScanner from '../components/FaceScanner';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { useAppStore } from '../store/useAppStore';
import { toPercent } from '../utils/helpers';

const steps = [
  { id: 'barcode', label: 'Scan Barcode' },
  { id: 'front', label: 'Scan DL Front' },
  { id: 'result', label: 'Result' }
] as const;

export default function Home() {
  const { step, license, faceResult, barcodeRaw, croppedFaceImage, goToStep, reset } = useAppStore();

  function canOpenStep(stepId: (typeof steps)[number]['id']) {
    if (stepId === 'barcode') return true;
    if (stepId === 'front') return Boolean(license);
    return Boolean(faceResult);
  }

  return (
    <main className="min-h-screen bg-white">
      <section className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="mb-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-[#2563EB]">AutoID Verification</p>
          <h1 className="mt-2 text-3xl font-semibold text-gray-950">Driver License face match</h1>
          <p className="mt-2 text-gray-600">Scan the barcode, crop the face from the card, then match it with the saved dataset.</p>
        </div>

        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          {steps.map((item, index) => {
            const active = item.id === step;
            const enabled = canOpenStep(item.id);
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => goToStep(item.id)}
                disabled={!enabled}
                className={`rounded-md border px-4 py-3 text-left text-sm font-medium transition ${
                  active ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-gray-200 text-gray-600'
                } ${enabled ? 'hover:border-[#2563EB] hover:text-[#2563EB]' : 'cursor-not-allowed bg-gray-50 text-gray-300'}
                }`}
              >
                {index + 1}. {item.label}
              </button>
            );
          })}
        </div>

        <Card>
          {step === 'barcode' && <BarcodeScanner />}
          {step === 'front' && <FaceScanner />}
          {step === 'result' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-gray-950">{faceResult?.matched ? 'Matched' : 'Not matched'}</h2>
                <p className="mt-1 text-gray-600">
                  Closest dataset face: {faceResult?.name ?? '-'} | Confidence: {toPercent(faceResult?.distance ?? null)}
                </p>
              </div>

              {croppedFaceImage && (
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700">Cropped Driver License Face</p>
                  <img
                    src={croppedFaceImage}
                    alt="Cropped face from Driver License"
                    className="max-h-72 rounded-md border border-gray-200 object-contain"
                  />
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-gray-500">Name</p>
                  <p className="font-medium text-gray-950">{license?.fullName || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">License Number</p>
                  <p className="font-medium text-gray-950">{license?.licenseNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">DOB</p>
                  <p className="font-medium text-gray-950">{license?.dob || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Issue Date</p>
                  <p className="font-medium text-gray-950">{license?.issueDate || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Expiration Date</p>
                  <p className="font-medium text-gray-950">{license?.expirationDate || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Gender</p>
                  <p className="font-medium text-gray-950">{license?.gender || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Address</p>
                  <p className="font-medium text-gray-950">
                    {license ? [license.address.street, license.address.city, license.address.state, license.address.zip].filter(Boolean).join(', ') : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Country</p>
                  <p className="font-medium text-gray-950">{license?.country || '-'}</p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-gray-700">Raw PDF417</p>
                <pre className="max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap">
                  {barcodeRaw || '-'}
                </pre>
              </div>

              <Button onClick={reset}>Start Over</Button>
            </div>
          )}
        </Card>
      </section>
    </main>
  );
}
