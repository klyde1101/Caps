import { captionLayout } from './layout.js';

// Browser-safe so the renderer and both generation entry points use identical names.
export function captionOutputPath(inputPath, orientation) {
  const suffix = captionLayout(orientation).orientation.replace(':', 'X');
  const separator = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'));
  const extension = inputPath.lastIndexOf('.');
  const stem = extension > separator + 1 ? inputPath.slice(0, extension) : inputPath;
  return stem + '_' + suffix + '.srt';
}
