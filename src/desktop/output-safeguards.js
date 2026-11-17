import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DesktopRequestError, validateOutputPath } from './ipc-contract.js';
import { styledCaptionPath } from '../exporters/ttml.js';

export async function prepareOutput({ inputPath, outputPath, overwrite = false }, dependencies = {}) {
  const checkAccess = dependencies.access ?? access;
  const getStat = dependencies.stat ?? stat;
  const finalOutputPath = validateOutputPath(outputPath);
  if (resolve(inputPath).toLowerCase() === resolve(finalOutputPath).toLowerCase()) {
    throw new DesktopRequestError('INVALID_REQUEST', 'Input and output must be different files.');
  }
  try {
    await checkAccess(inputPath, constants.R_OK);
  } catch (error) {
    throw new DesktopRequestError('INVALID_INPUT', `The input file cannot be read: ${error.message}`);
  }
  try {
    await checkAccess(dirname(finalOutputPath), constants.W_OK);
  } catch (error) {
    throw new DesktopRequestError('OUTPUT_UNWRITABLE', `The output folder is not writable: ${error.message}`);
  }
  for (const destination of [finalOutputPath, styledCaptionPath(finalOutputPath)]) {
  const outputExists = await getStat(destination).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw new DesktopRequestError('OUTPUT_UNWRITABLE', `The output path could not be inspected: ${error.message}`);
  });
  if (outputExists && !overwrite) throw new DesktopRequestError('OUTPUT_CONFLICT', 'The output file already exists.');
  }
  return finalOutputPath;
}
