import Want from '@ohos.app.ability.Want';
import common from '@ohos.app.ability.common';
import { BusinessError } from '@ohos.base';
import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';

const USER_HOME: string = '/storage/Users/currentUser';

/** Launch acceptance or a stage-specific failure; code is zero without an SDK error. */
export class PathActionResult {
  opened: boolean = false;
  reason: string = 'failed';
  stage: string = 'validate';
  code: number = 0;
}

function failedPathAction(reason: string, stage: string, code: number = 0): PathActionResult {
  const result = new PathActionResult();
  result.reason = reason;
  result.stage = stage;
  result.code = code;
  return result;
}

function platformFailure(error: BusinessError, stage: string): PathActionResult {
  const code = typeof error.code === 'number' ? error.code : 0;
  let reason = 'failed';
  if (code === 13900001 || code === 13900012 || code === 201 || code === 16000005) {
    reason = 'access-denied';
  } else if (code === 13900002) {
    reason = 'not-found';
  } else if (stage === 'launch' && (code === 16000001 || code === 16000019)) {
    reason = 'no-handler';
  }
  console.warn(`PathActions: ${stage} failed (${reason}, code ${code}).`);
  return failedPathAction(reason, stage, code);
}

/** Normalize literal absolute paths, not URLs, abbreviations or shell expressions. */
function normalizeUserPath(path: string): string {
  if (!path.startsWith('/') || /[\u0000-\u001f\u007f]|\.{3,}|…/.test(path)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return '';
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = '/' + parts.join('/');
  return normalized === USER_HOME || normalized.startsWith(USER_HOME + '/') ? normalized : '';
}

/** Reject symlinks instead of resolving them into potentially private storage. */
async function inspectUserPath(path: string): Promise<fs.Stat | undefined> {
  let current = USER_HOME;
  let info = await fs.lstat(current);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return undefined;
  }
  const relative = path.slice(USER_HOME.length + 1);
  if (relative === '') {
    return info;
  }
  for (const part of relative.split('/')) {
    if (!info.isDirectory()) {
      return undefined;
    }
    current += '/' + part;
    info = await fs.lstat(current);
    if (info.isSymbolicLink()) {
      return undefined;
    }
  }
  return info;
}

/**
 * Shows a directory or a file's parent directory in Huawei's file manager.
 * Does not read file contents, open an editor, request file grants or copy files.
 * @param context - Foreground ability context used to start the file manager.
 * @param path - Literal absolute user-home path; the caller expands a leading tilde.
 * @returns Launch acceptance or a reason, stage and SDK code; selection of the
 * original file inside its parent directory is not guaranteed.
 */
export async function viewInFileManager(context: common.UIAbilityContext,
  path: string): Promise<PathActionResult> {
  const normalized = normalizeUserPath(path);
  if (normalized === '') {
    return failedPathAction('invalid-path', 'validate');
  }
  let target: string;
  try {
    const info = await inspectUserPath(normalized);
    if (info === undefined || (!info.isFile() && !info.isDirectory())) {
      return failedPathAction('unsupported-path', 'inspect');
    }
    target = info.isDirectory() ? normalized : normalized.slice(0, normalized.lastIndexOf('/'));
  } catch (error) {
    return platformFailure(error as BusinessError, 'inspect');
  }
  let uri: string;
  try {
    uri = fileUri.getUriFromPath(target);
  } catch (error) {
    return platformFailure(error as BusinessError, 'uri');
  }
  if (!uri.startsWith('file://')) {
    return failedPathAction('invalid-path', 'uri');
  }
  // Huawei-specific folder launch, already verified on the target device.
  // https://ost.51cto.com/answer/40848 documents MainAbility + fileUri.
  const want: Want = {
    bundleName: 'com.huawei.hmos.filemanager',
    abilityName: 'MainAbility',
    parameters: { 'fileUri': uri }
  };
  try {
    await context.startAbility(want);
  } catch (error) {
    return platformFailure(error as BusinessError, 'launch');
  }
  const result = new PathActionResult();
  result.opened = true;
  result.reason = 'none';
  result.stage = 'launch';
  return result;
}
