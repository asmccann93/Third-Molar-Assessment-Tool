/* ==========================================================================
   Implant tool — CBCT viewer core.  oralsurgeryassess.com/implant/
   Developed by Aiden McCann.

   Turns a folder of DICOM files into a volume in millimetres, and cuts planes
   through it. Nothing else. It does not read the scan for you: no thresholds,
   no nerve tracing, no bone detection. Every measurement is two points the
   clinician placed.

   Deliberately:
   - runs entirely in the page. The files are read from the clinician's own
     disk with the File API and never leave the browser;
   - reads NO identifying tag. Patient name, ID, birth date and the rest are
     never parsed into anything this module returns, so nothing downstream can
     display them by accident;
   - takes geometry only from ImagePositionPatient, ImageOrientationPatient and
     PixelSpacing. SliceThickness is not slice spacing and is ignored; file
     order and InstanceNumber are not spatial order and are ignored.

   Works in the browser and in Node (tests). dicomParser is passed in, so the
   module has no import to resolve.
   ========================================================================== */

// Uncompressed transfer syntaxes. Anything else is refused with a message that
// says so, rather than drawn as noise.
var SUPPORTED_TS = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian"
};

function num(ds, tag, i) {
  var s = ds.string(tag);
  if (s === undefined || s === "") return null;
  var parts = s.split("\\");
  var v = parseFloat(parts[i || 0]);
  return isFinite(v) ? v : null;
}
function nums(ds, tag) {
  var s = ds.string(tag);
  if (!s) return null;
  var out = s.split("\\").map(parseFloat);
  return out.every(isFinite) ? out : null;
}
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function len(a) { return Math.sqrt(dot(a, a)); }

export class ScanError extends Error {}

/* One file -> the geometry and pixels of one slice, or null if it is not an
   image slice (a DICOMDIR, a report, a thumbnail). */
function readSlice(buffer, dicomParser) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var ds;
  try { ds = dicomParser.parseDicom(bytes); } catch (e) { return { skip: "not DICOM" }; }

  var pixel = ds.elements.x7fe00010;
  if (!pixel) return { skip: "no image" };

  var ts = ds.string("x00020010");
  if (ts && !SUPPORTED_TS[ts.trim()]) {
    throw new ScanError(
      "This scan was exported compressed (transfer syntax " + ts.trim() + "). " +
      "Export it again uncompressed from your CBCT software, or ask for compressed support to be added.");
  }
  var frames = parseInt(ds.string("x00280008") || "1", 10);
  if (frames > 1) {
    throw new ScanError(
      "This scan was exported as a single multi-frame file. Export it as one file per slice, " +
      "or ask for multi-frame support to be added.");
  }
  var bits = ds.uint16("x00280100");
  var samples = ds.uint16("x00280002") || 1;
  if (bits !== 16 || samples !== 1) {
    throw new ScanError("Unsupported pixel format (" + samples + " sample(s), " + bits + " bits).");
  }

  var ipp = nums(ds, "x00200032");
  var iop = nums(ds, "x00200037");
  var ps = nums(ds, "x00280030");
  if (!ipp || !iop || iop.length !== 6 || !ps) return { skip: "no geometry" };

  var rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011");
  var signed = ds.uint16("x00280103") === 1;
  var slope = num(ds, "x00281053"); if (slope === null) slope = 1;
  var intercept = num(ds, "x00281052"); if (intercept === null) intercept = 0;

  var n = rows * cols;
  if (pixel.length < n * 2) throw new ScanError("A slice is shorter than its own header says.");
  // Copy out: the parser's view points into a buffer we are about to drop.
  var raw = signed
    ? new Int16Array(bytes.buffer.slice(bytes.byteOffset + pixel.dataOffset, bytes.byteOffset + pixel.dataOffset + n * 2))
    : new Uint16Array(bytes.buffer.slice(bytes.byteOffset + pixel.dataOffset, bytes.byteOffset + pixel.dataOffset + n * 2));

  return {
    series: ds.string("x0020000e") || "",
    rows: rows, cols: cols,
    ipp: ipp, row: iop.slice(0, 3), col: iop.slice(3, 6),
    // DICOM PixelSpacing is [between rows, between columns].
    rowSpacing: ps[0], colSpacing: ps[1],
    slope: slope, intercept: intercept, raw: raw
  };
}

/* Many files -> one volume.
   Returns { nx, ny, nz, spacing:[sx,sy,sz], origin, xDir, yDir, zDir, hu, warnings }.
   hu is a Float32Array in Hounsfield-like units, index = x + nx*(y + ny*z). */
export function loadSeries(buffers, dicomParser) {
  var slices = [], skipped = 0;
  for (var i = 0; i < buffers.length; i++) {
    var s = readSlice(buffers[i], dicomParser);
    if (s.skip) { skipped++; continue; }
    slices.push(s);
  }
  if (!slices.length) throw new ScanError("No CBCT image slices were found in those files.");

  var warnings = [];
  // Several series in one folder: take the one with the most slices, and say so.
  var bySeries = {};
  slices.forEach(function (s) { (bySeries[s.series] = bySeries[s.series] || []).push(s); });
  var keys = Object.keys(bySeries);
  if (keys.length > 1) {
    keys.sort(function (a, b) { return bySeries[b].length - bySeries[a].length; });
    warnings.push("The folder held " + keys.length + " series; the largest (" + bySeries[keys[0]].length + " slices) was loaded.");
  }
  slices = bySeries[keys[0]];
  if (slices.length < 2) throw new ScanError("Only one slice was found. A CBCT needs the whole series.");

  var first = slices[0];
  var xDir = first.row, yDir = first.col, zDir = cross(xDir, yDir);
  slices.forEach(function (s) {
    if (s.rows !== first.rows || s.cols !== first.cols) throw new ScanError("Slices in this series are different sizes.");
    if (Math.abs(dot(s.row, xDir) - 1) > 1e-4 || Math.abs(dot(s.col, yDir) - 1) > 1e-4)
      throw new ScanError("Slices in this series are tilted differently from each other.");
    if (Math.abs(s.rowSpacing - first.rowSpacing) > 1e-4 || Math.abs(s.colSpacing - first.colSpacing) > 1e-4)
      throw new ScanError("Slices in this series have different pixel spacing.");
  });

  // Spatial order, from position along the slice normal. Never file order.
  slices.forEach(function (s) { s.d = dot(s.ipp, zDir); });
  slices.sort(function (a, b) { return a.d - b.d; });

  var gaps = [];
  for (var k = 1; k < slices.length; k++) gaps.push(slices[k].d - slices[k - 1].d);
  var sz = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length;
  if (!(sz > 0)) throw new ScanError("Two slices share a position; the series is duplicated or corrupt.");
  var worst = Math.max.apply(null, gaps.map(function (g) { return Math.abs(g - sz); }));
  if (worst > sz * 0.05) {
    throw new ScanError("Slice spacing is uneven (from " + Math.min.apply(null, gaps).toFixed(3) + " to " +
      Math.max.apply(null, gaps).toFixed(3) + " mm). Measurements would not be reliable, so this scan was not loaded.");
  }

  var nx = first.cols, ny = first.rows, nz = slices.length;
  var hu = new Float32Array(nx * ny * nz);
  slices.forEach(function (s, z) {
    var base = z * nx * ny, raw = s.raw;
    for (var p = 0; p < raw.length; p++) hu[base + p] = raw[p] * s.slope + s.intercept;
  });

  return {
    nx: nx, ny: ny, nz: nz,
    // x steps along a row (between columns), y steps down a column (between rows)
    spacing: [first.colSpacing, first.rowSpacing, sz],
    origin: slices[0].ipp.slice(), xDir: xDir, yDir: yDir, zDir: zDir,
    hu: hu, warnings: warnings, skipped: skipped
  };
}

/* Value at a point in patient millimetres, trilinear. Outside the scan -> air. */
export function sampleMm(vol, p) {
  var r = sub(p, vol.origin);
  var fx = dot(r, vol.xDir) / vol.spacing[0];
  var fy = dot(r, vol.yDir) / vol.spacing[1];
  var fz = dot(r, vol.zDir) / vol.spacing[2];
  return sampleVoxel(vol, fx, fy, fz);
}
export function sampleVoxel(vol, fx, fy, fz) {
  var nx = vol.nx, ny = vol.ny, nz = vol.nz;
  if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return -1000;
  var x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  var x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), z1 = Math.min(z0 + 1, nz - 1);
  var tx = fx - x0, ty = fy - y0, tz = fz - z0, h = vol.hu, sxy = nx * ny;
  var c00 = h[x0 + nx*y0 + sxy*z0] * (1-tx) + h[x1 + nx*y0 + sxy*z0] * tx;
  var c10 = h[x0 + nx*y1 + sxy*z0] * (1-tx) + h[x1 + nx*y1 + sxy*z0] * tx;
  var c01 = h[x0 + nx*y0 + sxy*z1] * (1-tx) + h[x1 + nx*y0 + sxy*z1] * tx;
  var c11 = h[x0 + nx*y1 + sxy*z1] * (1-tx) + h[x1 + nx*y1 + sxy*z1] * tx;
  return (c00 * (1-ty) + c10 * ty) * (1-tz) + (c01 * (1-ty) + c11 * ty) * tz;
}

/* A plane through the volume, as an image with square pixels of `step` mm.
   centre: patient mm. u: direction of image columns (left to right). v:
   direction of image rows (bottom to top, so "up" on screen is +v). */
export function reslice(vol, centre, u, v, widthMm, heightMm, step) {
  var lu = len(u), lv = len(v);
  u = [u[0]/lu, u[1]/lu, u[2]/lu]; v = [v[0]/lv, v[1]/lv, v[2]/lv];
  if (Math.abs(dot(u, v)) > 1e-6) throw new Error("reslice: u and v must be perpendicular");
  var w = Math.round(widthMm / step), h = Math.round(heightMm / step);
  var data = new Float32Array(w * h);
  for (var j = 0; j < h; j++) {
    var dv = (h / 2 - j - 0.5) * step;               // row 0 is the top of the image
    for (var i = 0; i < w; i++) {
      var du = (i - w / 2 + 0.5) * step;
      data[i + w * j] = sampleMm(vol, [
        centre[0] + u[0]*du + v[0]*dv,
        centre[1] + u[1]*du + v[1]*dv,
        centre[2] + u[2]*du + v[2]*dv]);
    }
  }
  return { w: w, h: h, step: step, centre: centre, u: u, v: v, data: data };
}

/* Pixel (i, j) on a resliced image -> patient mm. The ruler converts both ends
   this way and measures in 3D, so the distance never depends on screen zoom. */
export function imageToMm(img, i, j) {
  var du = (i - img.w / 2 + 0.5) * img.step, dv = (img.h / 2 - j - 0.5) * img.step;
  return [
    img.centre[0] + img.u[0]*du + img.v[0]*dv,
    img.centre[1] + img.u[1]*du + img.v[1]*dv,
    img.centre[2] + img.u[2]*du + img.v[2]*dv];
}
export function distanceMm(a, b) { return len(sub(a, b)); }

/* The cross-section for implant planning: perpendicular to the arch at a
   point. `along` is the arch direction at that point (from two clicks on the
   axial view), in patient mm. The section's columns run buccal-lingual and its
   rows run up the patient's z. */
export function crossSection(vol, point, along, widthMm, heightMm, step) {
  var up = vol.zDir;
  // remove any vertical component from the arch direction, then turn it 90 degrees in the axial plane
  var a = sub(along, [up[0]*dot(along, up), up[1]*dot(along, up), up[2]*dot(along, up)]);
  var across = cross(up, a);
  return reslice(vol, point, across, up, widthMm, heightMm, step);
}

/* Window/level to 8-bit grey, for a canvas. */
export function toGrey(img, level, width) {
  var out = new Uint8ClampedArray(img.w * img.h * 4), lo = level - width / 2;
  for (var p = 0; p < img.w * img.h; p++) {
    var g = Math.max(0, Math.min(255, ((img.data[p] - lo) / width) * 255));
    out[p*4] = out[p*4+1] = out[p*4+2] = g; out[p*4+3] = 255;
  }
  return out;
}
