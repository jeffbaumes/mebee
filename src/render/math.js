// Column-major 4x4 matrices, matching WGSL's mat4x4f memory layout.

export function mat4() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

export function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c*4], b1 = b[c*4+1], b2 = b[c*4+2], b3 = b[c*4+3];
    out[c*4+0] = a[0]*b0 + a[4]*b1 + a[8]*b2  + a[12]*b3;
    out[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2  + a[13]*b3;
    out[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
    out[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
  }
  return out;
}

/** Right-handed look-at; view space has -Z forward. */
export function lookAt(out, eye, target, up) {
  const z = normalize(subtract([], eye, target));
  const x = normalize(cross([], up, z));
  const y = cross([], z, x);
  out[0]=x[0]; out[1]=y[0]; out[2]=z[0];  out[3]=0;
  out[4]=x[1]; out[5]=y[1]; out[6]=z[1];  out[7]=0;
  out[8]=x[2]; out[9]=y[2]; out[10]=z[2]; out[11]=0;
  out[12]=-dot(x,eye); out[13]=-dot(y,eye); out[14]=-dot(z,eye); out[15]=1;
  return out;
}

/** Perspective with a 0..1 depth range, as WebGPU expects. */
export function perspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

/** Orthographic with a 0..1 depth range, for the sun's shadow projection. */
export function ortho(out, halfW, halfH, near, far) {
  out.fill(0);
  out[0] = 1 / halfW;
  out[5] = 1 / halfH;
  out[10] = 1 / (near - far);
  out[14] = near / (near - far);
  out[15] = 1;
  return out;
}

export function invert(out, m) {
  const [a00,a01,a02,a03, a10,a11,a12,a13, a20,a21,a22,a23, a30,a31,a32,a33] = m;
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return null;
  det = 1 / det;
  out[0]=(a11*b11-a12*b10+a13*b09)*det;  out[1]=(a02*b10-a01*b11-a03*b09)*det;
  out[2]=(a31*b05-a32*b04+a33*b03)*det;  out[3]=(a22*b04-a21*b05-a23*b03)*det;
  out[4]=(a12*b08-a10*b11-a13*b07)*det;  out[5]=(a00*b11-a02*b08+a03*b07)*det;
  out[6]=(a32*b02-a30*b05-a33*b01)*det;  out[7]=(a20*b05-a22*b02+a23*b01)*det;
  out[8]=(a10*b10-a11*b08+a13*b06)*det;  out[9]=(a01*b08-a00*b10-a03*b06)*det;
  out[10]=(a30*b04-a31*b02+a33*b00)*det; out[11]=(a21*b02-a20*b04-a23*b00)*det;
  out[12]=(a11*b07-a10*b09-a12*b06)*det; out[13]=(a00*b09-a01*b07+a02*b06)*det;
  out[14]=(a31*b01-a30*b03-a32*b00)*det; out[15]=(a20*b03-a21*b01+a22*b00)*det;
  return out;
}

export const subtract = (o,a,b) => { o[0]=a[0]-b[0]; o[1]=a[1]-b[1]; o[2]=a[2]-b[2]; return o; };
export const cross = (o,a,b) => {
  const x=a[1]*b[2]-a[2]*b[1], y=a[2]*b[0]-a[0]*b[2], z=a[0]*b[1]-a[1]*b[0];
  o[0]=x; o[1]=y; o[2]=z; return o;
};
export const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const normalize = (a) => {
  const l = Math.hypot(a[0],a[1],a[2]) || 1;
  a[0]/=l; a[1]/=l; a[2]/=l; return a;
};
