import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function startPackagedEditorJob(page, root, output) {
  await mkdir(output, { recursive: true });
  const input = join(output, 'editor-check.mp4');
  await copyFile(join(root, 'data/ui-qa/round3/sample.mp4'), input);
  await page.evaluate(() => {
    const element = document.createElement('input'); element.type = 'file'; element.id = 'qa-source';
    element.hidden = true; document.body.append(element);
  });
  const session = await page.context().newCDPSession(page);
  const doc = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#qa-source' });
  await session.send('DOM.setFileInputFiles', { nodeId, files: [input] });
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(document.querySelector('#qa-source').files[0]);
    document.querySelector('#drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  await page.waitForFunction(() => !document.querySelector('#start-job').disabled);
  await page.locator('#start-job').click();
  await page.waitForFunction(() => !document.querySelector('#completed-view').hidden || !document.querySelector('#failed-view').hidden, null, { timeout: 180000 });
  if (await page.locator('#failed-view').isVisible()) throw Error(await page.locator('#error-message').textContent());
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
}
