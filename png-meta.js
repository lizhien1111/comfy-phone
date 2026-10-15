/**
 * Parse ComfyUI PNG metadata (tEXt / iTXt / zTXt) in the browser.
 */
(function (root) {
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function u32(view, off) {
    return view.getUint32(off, false);
  }

  function latin1(bytes, start, end) {
    var s = "";
    for (var i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function utf8(bytes, start, end) {
    try {
      return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
    } catch (e) {
      return latin1(bytes, start, end);
    }
  }

  function findNul(bytes, start, end) {
    for (var i = start; i < end; i++) if (bytes[i] === 0) return i;
    return -1;
  }

  function inflateZlib(bytes) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("浏览器不支持解压 zTXt"));
    }
    function tryStream(fmt) {
      var ds = new DecompressionStream(fmt);
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new Response(new Blob([ab]).stream().pipeThrough(ds)).arrayBuffer();
    }
    return tryStream("deflate").catch(function () {
      return tryStream("deflate-raw");
    });
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<{texts: Object.<string,string>, prompt: object|null, workflow: object|null}>}
   */
  async function parsePngComfyMeta(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 8) throw new Error("文件太小，不是 PNG");
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIG[i]) throw new Error("不是有效的 PNG 文件");
    }

    var view = new DataView(arrayBuffer);
    var offset = 8;
    var texts = {};
    var pendingZ = [];

    while (offset + 12 <= bytes.length) {
      var len = u32(view, offset);
      var type = latin1(bytes, offset + 4, offset + 8);
      var dataStart = offset + 8;
      var dataEnd = dataStart + len;
      if (dataEnd + 4 > bytes.length) break;
      var chunk = bytes.subarray(dataStart, dataEnd);

      if (type === "tEXt") {
        var nul = findNul(chunk, 0, chunk.length);
        if (nul > 0) {
          var key = latin1(chunk, 0, nul);
          texts[key] = latin1(chunk, nul + 1, chunk.length);
        }
      } else if (type === "iTXt") {
        var kEnd = findNul(chunk, 0, chunk.length);
        if (kEnd > 0 && kEnd + 3 <= chunk.length) {
          var ikey = latin1(chunk, 0, kEnd);
          var compFlag = chunk[kEnd + 1];
          var p = kEnd + 3;
          var langEnd = findNul(chunk, p, chunk.length);
          if (langEnd < 0) langEnd = p;
          p = langEnd + 1;
          var trEnd = findNul(chunk, p, chunk.length);
          if (trEnd < 0) trEnd = p;
          p = trEnd + 1;
          if (compFlag === 0) {
            texts[ikey] = utf8(chunk, p, chunk.length);
          } else {
            pendingZ.push({ key: ikey, data: chunk.subarray(p) });
          }
        }
      } else if (type === "zTXt") {
        var zn = findNul(chunk, 0, chunk.length);
        if (zn > 0 && zn + 2 <= chunk.length) {
          pendingZ.push({ key: latin1(chunk, 0, zn), data: chunk.subarray(zn + 2) });
        }
      } else if (type === "IEND") {
        break;
      }

      offset = dataEnd + 4;
    }

    for (var z = 0; z < pendingZ.length; z++) {
      try {
        var inflated = new Uint8Array(await inflateZlib(pendingZ[z].data));
        texts[pendingZ[z].key] = utf8(inflated, 0, inflated.length);
      } catch (e) {
        /* skip unreadable compressed chunk */
      }
    }

    var prompt = null;
    var workflow = null;
    if (texts.prompt) {
      try {
        prompt = JSON.parse(texts.prompt);
      } catch (e) {
        /* ignore */
      }
    }
    if (texts.workflow) {
      try {
        workflow = JSON.parse(texts.workflow);
      } catch (e) {
        /* ignore */
      }
    }

    return { texts: texts, prompt: prompt, workflow: workflow };
  }

  function isSampler(ct) {
    return (
      ct === "KSampler" ||
      ct === "KSamplerAdvanced" ||
      ct === "SamplerCustom" ||
      /Sampler/i.test(ct || "")
    );
  }

  function isLatent(ct) {
    return (
      ct === "EmptyLatentImage" ||
      ct === "EmptySD3LatentImage" ||
      ct === "EmptyLatentImageFromBatch" ||
      /EmptyLatent/i.test(ct || "")
    );
  }

  function isTextEncode(ct) {
    return (
      ct === "CLIPTextEncode" ||
      ct === "CLIPTextEncodeFlux" ||
      ct === "CLIPTextEncodeSDXL" ||
      /TextEncode/i.test(ct || "") ||
      ct === "CR Text" ||
      ct === "StringConstant"
    );
  }

  function nodeText(node) {
    if (!node || !node.inputs) return "";
    var t = node.inputs.text != null ? node.inputs.text : node.inputs.string;
    if (typeof t === "string") return t;
    return "";
  }

  /**
   * Pull phone-form params from Comfy API-format prompt graph.
   * @param {object} apiPrompt
   * @returns {{prompt:string, negative:string, steps:number|null, width:number|null, height:number|null, seed:number|null, cfg:number|null, matchedLustify:boolean}}
   */
  function extractParamsFromApiPrompt(apiPrompt) {
    var out = {
      prompt: "",
      negative: "",
      steps: null,
      width: null,
      height: null,
      seed: null,
      cfg: null,
      matchedLustify: false,
    };
    if (!apiPrompt || typeof apiPrompt !== "object") return out;

    var samplerId = null;
    var sampler = null;
    var byId = apiPrompt;

    for (var id in byId) {
      if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
      var n = byId[id];
      if (!n || !n.class_type) continue;
      if (isSampler(n.class_type) && !sampler) {
        sampler = n;
        samplerId = id;
      }
      if (isLatent(n.class_type)) {
        if (n.inputs) {
          if (n.inputs.width != null) out.width = Number(n.inputs.width);
          if (n.inputs.height != null) out.height = Number(n.inputs.height);
        }
      }
      if (n.class_type === "UNETLoader" && n.inputs && /lustify/i.test(String(n.inputs.unet_name || ""))) {
        out.matchedLustify = true;
      }
    }

    if (sampler && sampler.inputs) {
      if (sampler.inputs.steps != null) out.steps = Number(sampler.inputs.steps);
      if (sampler.inputs.seed != null) out.seed = Number(sampler.inputs.seed);
      if (sampler.inputs.noise_seed != null && out.seed == null) {
        out.seed = Number(sampler.inputs.noise_seed);
      }
      if (sampler.inputs.cfg != null) out.cfg = Number(sampler.inputs.cfg);

      var posRef = sampler.inputs.positive;
      var negRef = sampler.inputs.negative;
      if (Array.isArray(posRef) && byId[posRef[0]]) {
        out.prompt = nodeText(byId[posRef[0]]);
      }
      if (Array.isArray(negRef) && byId[negRef[0]]) {
        out.negative = nodeText(byId[negRef[0]]);
      }
    }

    if (!out.prompt) {
      var encodes = [];
      for (var eid in byId) {
        if (!Object.prototype.hasOwnProperty.call(byId, eid)) continue;
        var en = byId[eid];
        if (en && isTextEncode(en.class_type)) {
          var tx = nodeText(en);
          if (tx) encodes.push(tx);
        }
      }
      if (encodes.length === 1) out.prompt = encodes[0];
      else if (encodes.length >= 2) {
        encodes.sort(function (a, b) {
          return b.length - a.length;
        });
        out.prompt = encodes[0];
        out.negative = encodes[1];
      }
    }

    return out;
  }

  /**
   * Fallback: UI workflow JSON (nodes[].widgets_values / type).
   */
  function extractParamsFromUiWorkflow(wf) {
    var out = {
      prompt: "",
      negative: "",
      steps: null,
      width: null,
      height: null,
      seed: null,
      cfg: null,
      matchedLustify: false,
    };
    if (!wf || !Array.isArray(wf.nodes)) return out;
    var texts = [];
    for (var i = 0; i < wf.nodes.length; i++) {
      var node = wf.nodes[i];
      var type = node.type || node.class_type || "";
      var wv = node.widgets_values;
      if (type === "UNETLoader" && Array.isArray(wv) && /lustify/i.test(String(wv[0] || ""))) {
        out.matchedLustify = true;
      }
      if (isTextEncode(type) && Array.isArray(wv) && typeof wv[0] === "string" && wv[0]) {
        texts.push(wv[0]);
      }
      if (isSampler(type) && Array.isArray(wv)) {
        // Common layout: seed, steps, cfg, sampler_name, scheduler, denoise
        if (typeof wv[0] === "number") out.seed = wv[0];
        if (typeof wv[1] === "number") out.steps = wv[1];
        if (typeof wv[2] === "number") out.cfg = wv[2];
      }
      if (isLatent(type) && Array.isArray(wv)) {
        if (typeof wv[0] === "number") out.width = wv[0];
        if (typeof wv[1] === "number") out.height = wv[1];
      }
    }
    if (texts.length === 1) out.prompt = texts[0];
    else if (texts.length >= 2) {
      texts.sort(function (a, b) {
        return b.length - a.length;
      });
      out.prompt = texts[0];
      out.negative = texts[1];
    }
    return out;
  }

  /**
   * Deep-clone API prompt and optionally override seed / steps on first sampler.
   */
  function patchApiPrompt(apiPrompt, opts) {
    var clone = JSON.parse(JSON.stringify(apiPrompt));
    opts = opts || {};
    for (var id in clone) {
      if (!Object.prototype.hasOwnProperty.call(clone, id)) continue;
      var n = clone[id];
      if (!n || !isSampler(n.class_type) || !n.inputs) continue;
      if (opts.seed != null && Number.isFinite(Number(opts.seed))) {
        if (n.inputs.seed != null) n.inputs.seed = Number(opts.seed);
        if (n.inputs.noise_seed != null) n.inputs.noise_seed = Number(opts.seed);
      }
      if (opts.steps != null && Number.isFinite(Number(opts.steps))) {
        if (n.inputs.steps != null) n.inputs.steps = Number(opts.steps);
      }
      break;
    }
    return clone;
  }

  root.ComfyPngMeta = {
    parsePngComfyMeta: parsePngComfyMeta,
    extractParamsFromApiPrompt: extractParamsFromApiPrompt,
    extractParamsFromUiWorkflow: extractParamsFromUiWorkflow,
    patchApiPrompt: patchApiPrompt,
  };
})(typeof window !== "undefined" ? window : globalThis);
