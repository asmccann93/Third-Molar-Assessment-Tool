// Build entry for /implant/viewer.js. The page loads the result only when the
// clinician opens a scan, so the assessment itself never waits for it.
export { default as dicomParser } from 'dicom-parser';
export * from './viewer-core.js';
