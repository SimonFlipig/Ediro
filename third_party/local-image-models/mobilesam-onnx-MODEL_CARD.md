---
license: mit
---
# ONNX models for MobileSAM

* Original repository: [MobileSAM (Github)](https://github.com/ChaoningZhang/MobileSAM)
* Original weights: [MobileSam (HuggingFace)](https://huggingface.co/dhkim2810/MobileSAM)

## Models

| Model | Description |
|-|-|
| mobile_sam_image_encoder.onnx | Image encoder created from MobileSAM weights |
| sam_mask_decoder_single.onnx | Mask decoder for SegmentAnything, returns a single mask |
| sam_mask_decoder_multi.onnx | Mask decoder for SegmentAnything, returns 4 masks |

## Export

The image encoder was exported with `export_image_enoder.py` found in this repository.
The mask decoders were exported with `export_models.py` from the MobileSAM repository.
