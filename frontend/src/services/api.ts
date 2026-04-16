import axios from 'axios';

export type LicenseData = {
  fullName: string;
  firstName: string;
  middleName: string;
  lastName: string;
  licenseNumber: string;
  gender: string;
  dob: string;
  expirationDate: string;
  issueDate: string;
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  country: string;
};

export type FaceResult = {
  matched: boolean;
  name: string | null;
  distance: number | null;
  threshold: number;
};

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api'
});

export async function submitBarcode(raw: string) {
  const response = await api.post<{ data: LicenseData }>('/barcode', { raw });
  return response.data.data;
}

export async function submitCardFace(image: string) {
  const response = await api.post<FaceResult>('/face', { image });
  return response.data;
}
