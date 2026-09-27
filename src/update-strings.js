// Text for the update indicator (see update.js), in Japanese and English. Copied in spirit from
// frame-updater's strings.md, shortened to fit the keyboard's narrow banner. `%s` is one value,
// substituted by fmt() in update.js.

/**
 * @typedef {object} UpdateStrings
 * @property {string} checking - Shown while a forced check is running
 * @property {string} installing - Shown while an update is being installed
 * @property {string} upToDateFormat - "Up to date (%s)" after a forced check finds nothing new
 * @property {string} availableFormat - "Version %s is available" (used in the confirm/manual banners)
 * @property {string} confirmFormat - "Update to %s?"
 * @property {string} confirmHint - Sub-text under the confirm question
 * @property {string} confirmYes - Confirm button label
 * @property {string} confirmNo - Cancel button label
 * @property {string} manual - Shown when the release can't be installed from here (no SHA256SUMS)
 * @property {string} installed - Shown if an install finishes while this page is still watching
 * @property {string} checkFailedPrefix - Before the error reason, after a forced check fails
 * @property {string} installFailedPrefix - Before the error reason, after an install fails
 * @property {string} dismiss - Close button label
 * @property {Record<string, string>} errors - Error code -> short reason (unknown codes fall back to "other")
 */

/** @type {Record<'ja'|'en', UpdateStrings>} */
export const UPDATE_STRINGS = Object.freeze({
  ja: {
    checking: '新しい版を確かめています…',
    installing: '更新中です…',
    upToDateFormat: '最新です（%s）',
    availableFormat: '新しい版 %s があります',
    confirmFormat: '%s に更新しますか？',
    confirmHint: 'ダウンロードして入れ替えます。途中でこの画面が閉じて開き直すことがあります',
    confirmYes: '更新する',
    confirmNo: 'やめる',
    manual: 'ここからは入れられない版です。GitHub から手で更新してね',
    installed: '更新しました',
    checkFailedPrefix: '新しい版を確かめられませんでした: ',
    installFailedPrefix: '更新できませんでした（今の版のままです）: ',
    dismiss: '閉じる',
    errors: {
      network: 'GitHub につながりません',
      'rate-limited': 'GitHub の回数制限にかかりました。しばらくしてから',
      'not-found': '公開されている版がありません',
      'bad-response': 'GitHub の返事を読めませんでした',
      'bad-version': '版の番号を読めませんでした',
      'bad-url': 'GitHub 以外の場所へ向かったので止めました',
      'missing-tool': '必要なコマンドがありません',
      'no-checksums': '確認用の SHA256SUMS がありません',
      'no-asset': '入れるファイルがありません',
      'checksum-mismatch': 'ダウンロードしたファイルが壊れています',
      'unsafe-archive': 'ファイルの中身が安全でないので止めました',
      'no-installer': 'ファイルに install.sh がありません',
      'install-failed': 'install.sh が失敗しました',
      'bad-args': '前回のインストールのオプションを読めません',
      busy: '別の更新が動いています',
      'not-newer': 'もう最新の版です',
      'detach-failed': '更新を始められませんでした',
      interrupted: '更新が途中で止まりました',
      io: 'ファイルを書けませんでした',
      usage: '更新の仕組みが動きませんでした',
      'script-failed': '更新の仕組みが動きませんでした',
      'spawn-failed': '更新の仕組みが動きませんでした',
      other: 'うまくいきませんでした',
    },
  },
  en: {
    checking: 'Checking for updates…',
    installing: 'Updating…',
    upToDateFormat: 'Up to date (%s)',
    availableFormat: 'Version %s is available',
    confirmFormat: 'Update to %s?',
    confirmHint: 'It downloads and installs the new version. This panel may close and reopen meanwhile',
    confirmYes: 'Update',
    confirmNo: 'Cancel',
    manual: "This version can't be installed from here. Update by hand from GitHub",
    installed: 'Update installed',
    checkFailedPrefix: "Couldn't check for updates: ",
    installFailedPrefix: 'The update failed (nothing was changed): ',
    dismiss: 'Close',
    errors: {
      network: "Can't reach GitHub",
      'rate-limited': "GitHub's rate limit was hit. Try again later",
      'not-found': 'No published release',
      'bad-response': "Couldn't read GitHub's answer",
      'bad-version': "Couldn't read the version number",
      'bad-url': 'Stopped: the download led outside GitHub',
      'missing-tool': 'A required command is missing',
      'no-checksums': 'This release has no SHA256SUMS',
      'no-asset': 'This release has no file to install',
      'checksum-mismatch': 'The download is corrupt',
      'unsafe-archive': 'Stopped: the archive has unsafe contents',
      'no-installer': 'The archive has no install.sh',
      'install-failed': 'install.sh failed',
      'bad-args': 'The saved install options are invalid',
      busy: 'Another update is running',
      'not-newer': 'Already up to date',
      'detach-failed': "Couldn't start the update",
      interrupted: 'The update was interrupted',
      io: "Couldn't write files",
      usage: "The updater didn't run",
      'script-failed': "The updater didn't run",
      'spawn-failed': "The updater didn't run",
      other: 'Something went wrong',
    },
  },
});
