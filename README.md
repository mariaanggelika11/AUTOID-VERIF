# autoid-verif

Simple Driver License verification app:

1. Scan PDF417 barcode from the back of a US Driver License.
2. Scan the front of the Driver License and crop the face from the card.
3. Compare that card face with images in `backend/src/storage/faces`.

The app never asks for or compares a user selfie.

## Structure

```txt
autoid-verif/
├── frontend/
└── backend/
```

## Run

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Backend runs on `http://localhost:5000`.
Frontend runs on `http://localhost:5173`.

## Config

Copy env examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

## Face Models

Add face-api model files:

- Frontend: `frontend/public/models`
- Backend: `backend/src/storage/models`

Required model set:

- `tiny_face_detector_model-*`
- `face_landmark_68_model-*`
- `face_recognition_model-*`

## Dataset

Put known face images in:

```txt
backend/src/storage/faces/
```

Example:

```txt
backend/src/storage/faces/john-doe.jpg
backend/src/storage/faces/jane-smith.png
```

## Deployment

Build:

```bash
npm run build
```

PM2 example:

```bash
pm2 start backend/dist/server.js --name autoid-verif-api
pm2 save
```

Nginx should proxy `/api` to `http://127.0.0.1:5000` and serve `frontend/dist`.
