# Face models

Checked in, so every deploy has them (`npm run faces:models` re-downloads them if missing):

| File | Source | License | SHA-256 |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` (232,589 B) | OpenCV Zoo YuNet | MIT | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` (38,696,353 B) | OpenCV Zoo SFace | Apache-2.0 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

Changing either file means changing `MODEL_ID` in `lib/faces/model.ts`. Vectors from different models are never compared, so existing faces need a rescan (admin → People → Delete all face data, then turn faces back on).
