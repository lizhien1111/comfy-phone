/**
 * Lustify Krea Turbo API workflow builder (matches gen_lustify_scant30.py).
 */
(function (root) {
  const UNET = "lustify-v10-krea-turbo-fp16.safetensors";
  const CLIP = "qwen3vl_4b_bf16.safetensors";
  const VAE = "wan_2.1_vae.safetensors";

  const DEFAULT_NEG =
    "extra heads, multiple heads, two heads, three heads, duplicate face, twin heads, conjoined, " +
    "extra limbs, fused bodies, bad anatomy, deformed face, mutated hands, " +
    "blurry, lowres, watermark, text, logo, cartoon, 3d render, plastic skin, penis, cock, dick, male genitals";

  /**
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.negative]
   * @param {number} opts.steps
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.seed
   * @param {number} [opts.cfg=1]
   * @param {string} [opts.prefix]
   */
  function buildWorkflow(opts) {
    const text = String(opts.prompt || "");
    const neg = opts.negative != null && String(opts.negative).length
      ? String(opts.negative)
      : DEFAULT_NEG;
    const steps = Number(opts.steps) || 30;
    const width = Number(opts.width) || 1280;
    const height = Number(opts.height) || 2560;
    const seed = Number(opts.seed) || 0;
    const cfg = opts.cfg != null ? Number(opts.cfg) : 1.0;
    const prefix = opts.prefix || ("phone_" + seed);

    return {
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: UNET, weight_dtype: "default" },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: { clip_name: CLIP, type: "krea2", device: "default" },
      },
      "3": {
        class_type: "VAELoader",
        inputs: { vae_name: VAE },
      },
      "4": {
        class_type: "ModelSamplingAuraFlow",
        inputs: { model: ["1", 0], shift: 4.0, sampling: "flow" },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: text, clip: ["2", 0] },
      },
      "6": {
        class_type: "CLIPTextEncode",
        inputs: { text: neg, clip: ["2", 0] },
      },
      "7": {
        class_type: "EmptyLatentImage",
        inputs: { width: width, height: height, batch_size: 1 },
      },
      "8": {
        class_type: "KSampler",
        inputs: {
          seed: seed,
          steps: steps,
          cfg: cfg,
          sampler_name: "euler",
          scheduler: "simple",
          denoise: 1.0,
          model: ["4", 0],
          positive: ["5", 0],
          negative: ["6", 0],
          latent_image: ["7", 0],
        },
      },
      "9": {
        class_type: "VAEDecode",
        inputs: { samples: ["8", 0], vae: ["3", 0] },
      },
      "10": {
        class_type: "SaveImage",
        inputs: { filename_prefix: prefix, images: ["9", 0] },
      },
    };
  }

  root.ComfyPhoneWorkflow = {
    UNET,
    CLIP,
    VAE,
    DEFAULT_NEG,
    buildWorkflow,
  };
})(typeof window !== "undefined" ? window : globalThis);
