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

// Uncompressed transfer syntaxes. Anything else is set aside with a reason,
// rather than drawn as noise.
var SUPPORTED_TS = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian"
};
var IMPLICIT_LE = "1.2.840.10008.1.2";

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
function unit(a) { var l = len(a); return l > 0 && isFinite(l) ? [a[0]/l, a[1]/l, a[2]/l] : null; }

export class ScanError extends Error {}

// Why a file was set aside, in words for the clinician. The first reason that
// accounts for the files is what they are told if nothing usable is left.
var SKIP = {
  notDicom: "not DICOM files",
  noImage: "DICOM files without an image (a directory or report)",
  compressed: "compressed images, which this viewer does not read yet",
  multiframe: "a single multi-frame file, which this viewer does not read yet",
  format: "images in a format other than 16-bit greyscale (a thumbnail, a colour preview)",
  noGeometry: "images without position and spacing information"
};

function parse(bytes, dicomParser) {
  try { return dicomParser.parseDicom(bytes); }
  catch (e) {
    // Some exports write bare datasets with no 128-byte preamble and no DICM
    // prefix. Those are almost always implicit little endian.
    // Anything parses as *something* this way, so only trust it if it holds a
    // tag every image slice has: the SOP class, the modality, or the rows.
    try {
      var ds = dicomParser.parseDicom(bytes, { TransferSyntaxUID: IMPLICIT_LE });
      var e = ds.elements;
      return e.x00080016 || e.x00080060 || e.x00280010 ? ds : null;
    } catch (e2) { return null; }
  }
}

/* One file -> the geometry and pixels of one slice, or { skip: reason } if it
   is not an image slice this viewer can use. A stray thumbnail or report in the
   folder is set aside, never fatal. */
function readSlice(buffer, dicomParser) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var ds = parse(bytes, dicomParser);
  if (!ds) return { skip: "notDicom" };

  var pixel = ds.elements.x7fe00010;
  if (!pixel) return { skip: "noImage" };

  var ts = ds.string("x00020010");
  if (ts && !SUPPORTED_TS[ts.trim()]) return { skip: "compressed" };
  if (parseInt(ds.string("x00280008") || "1", 10) > 1) return { skip: "multiframe" };
  var bits = ds.uint16("x00280100"), samples = ds.uint16("x00280002") || 1;
  if (bits !== 16 || samples !== 1) return { skip: "format" };

  var ipp = nums(ds, "x00200032"), iop = nums(ds, "x00200037"), ps = nums(ds, "x00280030");
  if (!ipp || ipp.length !== 3 || !iop || iop.length !== 6 || !ps || ps.length < 2) return { skip: "noGeometry" };
  var row = unit(iop.slice(0, 3)), col = unit(iop.slice(3, 6));
  if (!row || !col || !(ps[0] > 0) || !(ps[1] > 0)) return { skip: "noGeometry" };

  var rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011");
  var signed = ds.uint16("x00280103") === 1;
  var slope = num(ds, "x00281053"); if (slope === null) slope = 1;
  var intercept = num(ds, "x00281052"); if (intercept === null) intercept = 0;

  var n = rows * cols;
  if (!(n > 0) || pixel.length < n * 2) throw new ScanError("A slice is shorter than its own header says. The export may be incomplete.");
  // A view into the file's own bytes, not a copy: the volume is the only other
  // thing in memory. An odd offset cannot be viewed as 16-bit, so that one case copies.
  var off = bytes.byteOffset + pixel.dataOffset, T = signed ? Int16Array : Uint16Array;
  var raw = off % 2 === 0 ? new T(bytes.buffer, off, n) : new T(bytes.buffer.slice(off, off + n * 2));

  return {
    series: ds.string("x0020000e") || "",
    rows: rows, cols: cols, ipp: ipp, row: row, col: col,
    // DICOM PixelSpacing is [between rows, between columns].
    rowSpacing: ps[0], colSpacing: ps[1],
    slope: slope, intercept: intercept, raw: raw
  };
}

/* Many files -> one volume.
   Returns { nx, ny, nz, spacing:[sx,sy,sz], origin, xDir, yDir, zDir, hu, warnings, skipped }.
   hu is an Int16Array of Hounsfield-like units, index = x + nx*(y + ny*z).
   16-bit, not 32: a large-field dental CBCT (800 x 800 x 600) is 0.77 GB this
   way and would be twice that as floats, on top of the files themselves. */
export function loadSeries(buffers, dicomParser) {
  var slices = [], skipped = {};
  for (var i = 0; i < buffers.length; i++) {
    var s = readSlice(buffers[i], dicomParser);
    if (s.skip) { skipped[s.skip] = (skipped[s.skip] || 0) + 1; continue; }
    slices.push(s);
  }
  var skippedTotal = Object.keys(skipped).reduce(function (a, k) { return a + skipped[k]; }, 0);
  if (!slices.length) {
    var why = Object.keys(skipped).sort(function (a, b) { return skipped[b] - skipped[a]; })[0];
    throw new ScanError("No usable CBCT slices were found" + (why ? ": the files are " + SKIP[why] + "." : "."));
  }

  var warnings = [];
  if (skippedTotal) warnings.push(skippedTotal + " file" + (skippedTotal === 1 ? " was" : "s were") + " set aside as not part of the scan.");
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
  var xDir = first.row, yDir = first.col, zDir = unit(cross(xDir, yDir));
  if (!zDir || Math.abs(dot(xDir, yDir)) > 1e-3) throw new ScanError("The slice orientation in this scan is not valid.");
  slices.forEach(function (s) {
    if (s.rows !== first.rows || s.cols !== first.cols) throw new ScanError("Slices in this series are different sizes.");
    // Normalised, and a tolerance of 1e-3: exports that write the orientation
    // to three decimals must still compare equal to themselves.
    if (dot(s.row, xDir) < 1 - 1e-3 || dot(s.col, yDir) < 1 - 1e-3)
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
  // Each slice must sit straight on top of the last. A sheared stack (a tilted
  // gantry, a reformatted series) keeps even spacing along the normal while
  // drifting sideways, and every vertical measurement would come out short.
  var last = slices[slices.length - 1], drift = sub(last.ipp, first.ipp);
  var along = dot(drift, zDir), sideways = len(sub(drift, [zDir[0]*along, zDir[1]*along, zDir[2]*along]));
  if (sideways > Math.min(first.rowSpacing, first.colSpacing) / 2) {
    throw new ScanError("The slices are offset sideways from one another (a tilted or sheared series). " +
      "Measurements would not be reliable, so this scan was not loaded. Export it again as a straight axial series.");
  }

  var nx = first.cols, ny = first.rows, nz = slices.length;
  var hu = new Int16Array(nx * ny * nz);
  slices.forEach(function (s, z) {
    var base = z * nx * ny, raw = s.raw, sl = s.slope, ic = s.intercept;
    for (var p = 0; p < raw.length; p++) {
      var v = Math.round(raw[p] * sl + ic);
      hu[base + p] = v < -32768 ? -32768 : (v > 32767 ? 32767 : v);
    }
    s.raw = null;   // the file's bytes are the caller's to drop now
  });

  return {
    nx: nx, ny: ny, nz: nz,
    // x steps along a row (between columns), y steps down a column (between rows)
    spacing: [first.colSpacing, first.rowSpacing, sz],
    origin: slices[0].ipp.slice(), xDir: xDir, yDir: yDir, zDir: zDir,
    hu: hu, warnings: warnings, skipped: skippedTotal
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
  u = unit(u); v = unit(v);
  if (!u || !v || Math.abs(dot(u, v)) > 1e-6) throw new ScanError("reslice: u and v must be non-zero and perpendicular");
  if (!(step > 0) || !(widthMm > 0) || !(heightMm > 0)) throw new ScanError("reslice: size and step must be positive");
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
  var a = unit(sub(along, [up[0]*dot(along, up), up[1]*dot(along, up), up[2]*dot(along, up)]));
  // Two clicks on the same spot, or a direction straight up and down, give no
  // arch direction at all. Say so, rather than draw a black image and a NaN ruler.
  if (!a) throw new ScanError("Pick two different points along the arch to set its direction.");
  return reslice(vol, point, cross(up, a), up, widthMm, heightMm, step);
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
