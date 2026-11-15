# Face models

Not checked in yet. Run `npm run faces:models` to download them, then commit the `.onnx` files:

| File | Source | License |
|---|---|---|
| `face_detection_yunet_2023mar.onnx` (~230 KB) | OpenCV Zoo YuNet | MIT |
| `face_recognition_sface_2021dec.onnx` (~37 MB) | OpenCV Zoo SFace | Apache-2.0 |

Changing either file means changing `MODEL_ID` in `lib/faces/model.ts`. Vectors from different models are never compared, so existing faces need a rescan (admin → People → Delete all face data, then turn faces back on).
