# ComfyUI workflow templates

Studio (MEDIA_PROVIDER=comfy) loads **API-format** workflows from this folder:

| file       | operation                                   | tokens used                                                  |
|------------|---------------------------------------------|--------------------------------------------------------------|
| `t2i.json` | text → image (shipped, standard SDXL nodes) | `{{prompt}} {{negative}} {{seed}} {{width}} {{height}}`      |
| `i2v.json` | image → video                               | `{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{frames}} {{image}}` |
| `t2v.json` | text → video                                | `{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{frames}}` |
| `v2v.json` | video → video (restyle / extend / replace subject / camera move) | `{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{frames}} {{video}}` |
| `edit.json`| image edit                                  | `{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{image}}` |

Only `t2i.json` ships, because video/edit graphs depend on which custom nodes and checkpoints you installed.
To enable another operation: build it in ComfyUI with the model you have, use **Save (API Format)**, replace the
values you want Studio to control with the tokens above (e.g. `"text": "{{prompt}}"`, `"seed": "{{seed}}"`), and save it here under the filename in the table.
A token that is the entire string value is replaced by a number/string of the right type. Studio greys out any operation whose file is missing.

`t2i.json` expects the checkpoint `sd_xl_base_1.0.safetensors` in `ComfyUI/models/checkpoints`; edit `ckpt_name` to match yours.
