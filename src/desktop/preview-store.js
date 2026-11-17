import { lockedCaptionSave } from './locked-caption-save.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportSrt } from '../exporters/srt.js';
import { exportTtml } from '../exporters/ttml.js';
import { parseSrt } from '../parsers/whisperx-srt.js';
import { DesktopRequestError } from './ipc-contract.js';

const MAX_ENTRIES = 100;

export function createPreviewStore(dependencies = {}) {
  const loadFile = dependencies.readFile ?? readFile;
  const entries = new Map();
  const inputs = new Map();
  const styledExports = new Map();
  let cachedToken;
  let cachedCues;
  let saving = false;

  return {
    register(result, inputPath) {
      const { cues: _cues, ...summary } = result;
      const previewToken = randomUUID();
      entries.set(previewToken, result.outputPath);
      inputs.set(previewToken, inputPath);
      if (result.styledOutputPath && result.layout) styledExports.set(previewToken, { path: result.styledOutputPath, layout: result.layout });
      while (entries.size > MAX_ENTRIES) { const oldest = entries.keys().next().value; entries.delete(oldest); inputs.delete(oldest); styledExports.delete(oldest); }
      const extension = inputPath ? extname(inputPath).toLowerCase() : '.srt';
      return { ...summary, previewToken, mediaKind: extension === '.srt' ? 'subtitle' : ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension) ? 'audio' : 'video', mediaUrl: inputPath && extension !== '.srt' ? pathToFileURL(inputPath).href : null };
    },
    input(previewToken) {
      if (!inputs.has(previewToken)) throw new DesktopRequestError('INVALID_REQUEST', 'Unknown media preview.');
      return inputs.get(previewToken);
    },

    async save({ previewToken, changes, original } = {}) {
      if (saving) throw new DesktopRequestError('SAVE_BUSY', 'A caption save is already in progress.');
      if (!entries.has(previewToken) || !Array.isArray(changes) || changes.length < 1 || changes.length > 100000 || typeof original !== 'string') {
        throw new DesktopRequestError('INVALID_REQUEST', 'Invalid caption corrections.');
      }
      saving = true;
      const outputPath = entries.get(previewToken);
      const temporary = `${outputPath}.${randomUUID()}.tmp`;
      try {
        const current = await loadFile(outputPath, 'utf8');
        const cues = parseSrt(current);
        if (exportSrt(cues) !== original) throw new DesktopRequestError('OUTPUT_CONFLICT', 'This SRT changed outside CAPS. Reopen the preview before saving corrections.');
        const seen = new Set();
        for (const change of changes) {
          if (!change || !Number.isInteger(change.index) || change.index < 1 || change.index > cues.length || seen.has(change.index)
            || typeof change.text !== 'string' || !change.text.trim() || change.text.length > 10000 || /[\u0000-\u0008\u000b-\u001f<>]/u.test(change.text)
            || /\n\s*\n/u.test(change.text.replace(/\r\n?/g, '\n')) || change.text.includes('-->')) {
            throw new DesktopRequestError('INVALID_REQUEST', 'Captions must contain plain text without empty lines, tags, or timestamp arrows.');
          }
          seen.add(change.index);
          cues[change.index - 1].text = change.text.trim().replace(/\r\n?/g, '\n');
        }
        const content = exportSrt(cues);
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
        if (await loadFile(outputPath, 'utf8') !== current) {
          throw new DesktopRequestError('OUTPUT_CONFLICT', 'This SRT changed during saving. Your corrections have been retained.');
        }
        if (process.platform === 'win32') await (dependencies.lockedSave ?? lockedCaptionSave)(outputPath, current, content);
        else await rename(temporary, outputPath);
        cachedToken = undefined;
        let warning;
        const styled = styledExports.get(previewToken);
        if (styled) {
          const styledTemporary = `${styled.path}.${randomUUID()}.tmp`;
          try {
            await writeFile(styledTemporary, exportTtml(cues, styled.layout), { encoding: 'utf8', flag: 'wx' });
            await rename(styledTemporary, styled.path);
          } catch (error) {
            warning = `SRT saved. Styled TTML could not be updated: ${error.message}`;
          } finally { await rm(styledTemporary, { force: true }).catch(() => {}); }
        }
        return { saved: changes.length, original: content, ...(warning ? { warning } : {}) };
      } finally {
        saving = false;
        await rm(temporary, { force: true });
      }
    },

    async page({ previewToken, query = '', offset = 0, limit = 200 } = {}) {
      if (typeof previewToken !== 'string' || !entries.has(previewToken)) throw new DesktopRequestError('INVALID_REQUEST', 'Unknown caption preview.');
      if (typeof query !== 'string' || query.length > 200) throw new DesktopRequestError('INVALID_REQUEST', 'Preview search is invalid.');
      if (!Number.isInteger(offset) || offset < 0) throw new DesktopRequestError('INVALID_REQUEST', 'Preview offset is invalid.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DesktopRequestError('INVALID_REQUEST', 'Preview limit is invalid.');

      if (cachedToken !== previewToken || offset === 0) {
        cachedCues = parseSrt(await loadFile(entries.get(previewToken), 'utf8'));
        cachedToken = previewToken;
      }
      const normalized = query.trim().toLowerCase();
      const page = [];
      let matches = 0;
      for (let index = 0; index < cachedCues.length; index += 1) {
        const cue = cachedCues[index];
        if (normalized && !cue.text.toLowerCase().includes(normalized)) continue;
        if (matches >= offset && page.length < limit) page.push({ ...cue, index: index + 1 });
        matches += 1;
      }
      return { cues: page, offset, limit, matches, total: cachedCues.length };
    }
  };
}
