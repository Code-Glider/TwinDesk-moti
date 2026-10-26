// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The virtual camera's frames (shared/vcam.js), made in a camera's window: each picture
// (a VideoFrame, a video or a canvas) fitted into 1280×720 with black bars and turned into NV12
// on the GPU (WebGL2: one pass writes the Y rows and then the interleaved U/V rows, four bytes a
// pixel), read back and handed to send(ArrayBuffer), at most 30 a second. BT.601, limited range.
// window.VcamFeed(send) → {push(source, width, height)} or null without WebGL2.
'use strict';

(() => {
  const W = 1280, H = 720, FPS = 30;

  const VS = `#version 300 es
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  // Output row r (top first, as readPixels hands it back): r < H a row of Y, four pixels to an
  // output pixel; then H/2 rows of U,V for two chroma pixels each (each one 2×2 pixels).
  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D tex;
  uniform vec4 rect; // the picture in the frame: x, y, width, height (pixels)
  out vec4 o;
  vec4 at(vec2 p) {
    vec2 uv = (p - rect.xy) / rect.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
    return vec4(texture(tex, uv).rgb, 1.0);
  }
  float Y(vec4 c) { return c.a == 0.0 ? 16.0 / 255.0 : (16.0 + 65.481 * c.r + 128.553 * c.g + 24.966 * c.b) / 255.0; }
  vec2 UV(vec4 c) {
    return c.a == 0.0 ? vec2(128.0 / 255.0)
      : vec2(128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b, 128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b) / 255.0;
  }
  void main() {
    float x = floor(gl_FragCoord.x) * 4.0;
    float r = floor(gl_FragCoord.y);
    if (r < ${H}.0) {
      o = vec4(Y(at(vec2(x + 0.5, r + 0.5))), Y(at(vec2(x + 1.5, r + 0.5))), Y(at(vec2(x + 2.5, r + 0.5))), Y(at(vec2(x + 3.5, r + 0.5))));
    } else {
      float y = (r - ${H}.0) * 2.0 + 1.0;
      o = vec4(UV(at(vec2(x + 1.0, y))), UV(at(vec2(x + 3.0, y))));
    }
  }`;

  function VcamFeed(send) {
    const canvas = new OffscreenCanvas(W / 4, H * 3 / 2);
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
    const rect = gl.getUniformLocation(prog, 'rect');
    gl.viewport(0, 0, W / 4, H * 3 / 2);
    const out = new Uint8Array(W * H * 3 / 2);
    let last = 0;

    return {
      push(source, sw, sh) {
        const now = performance.now();
        if (now - last < 1000 / FPS - 3 || !sw || !sh) return;
        last = now;
        // Fitted in, centred, whole pixels.
        const k = Math.min(W / sw, H / sh);
        const cw = Math.round(sw * k), ch = Math.round(sh * k);
        gl.uniform4f(rect, Math.floor((W - cw) / 2), Math.floor((H - ch) / 2), cw, ch);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        } catch {
          return;
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, W / 4, H * 3 / 2, gl.RGBA, gl.UNSIGNED_BYTE, out);
        send(out.buffer);
      },
    };
  }

  window.VcamFeed = (send) => {
    try {
      return VcamFeed(send);
    } catch (e) {
      console.warn('vcam', e.message);
      return null;
    }
  };
})();
