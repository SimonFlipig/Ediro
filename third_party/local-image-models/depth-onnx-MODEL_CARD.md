---
base_model: depth-anything/Depth-Anything-V2-Small
library_name: transformers.js
license: apache-2.0
pipeline_tag: depth-estimation
---

https://huggingface.co/depth-anything/Depth-Anything-V2-Small with ONNX weights to be compatible with Transformers.js.

## Usage (Transformers.js)

If you haven't already, you can install the [Transformers.js](https://huggingface.co/docs/transformers.js) JavaScript library from [NPM](https://www.npmjs.com/package/@huggingface/transformers) using:
```bash
npm i @huggingface/transformers
```

**Example:** Depth estimation w/ `onnx-community/depth-anything-v2-small`.
```js
import { pipeline } from '@huggingface/transformers';

// Create depth estimation pipeline
const depth_estimator = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small-ONNX');

// Predict depth of an image
const url = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg';
const { depth } = await depth_estimator(url);

// Visualize the output
depth.save('depth.png');
```

![depth](https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/hhP5OJL1f1MP3iCxfJ-TU.png)

---

Note: Having a separate repo for ONNX weights is intended to be a temporary solution until WebML gains more traction. If you would like to make your models web-ready, we recommend converting to ONNX using [🤗 Optimum](https://huggingface.co/docs/optimum/index) and structuring your repo like this one (with ONNX weights located in a subfolder named `onnx`).