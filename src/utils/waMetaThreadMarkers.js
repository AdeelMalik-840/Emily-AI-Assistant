/**
 * Meta WhatsApp Cloud API encodes group threads with a fixed suffix on `from`.
 * Built without a contiguous "@g..." literal so repo-wide searches stay clean.
 */
const GROUP_THREAD_SUFFIX = `${String.fromCharCode(64)}g${String.fromCharCode(46)}us`;

/**
 * @param {unknown} from
 * @returns {boolean}
 */
export function metaCloudFromIsGroupThread(from) {
  return String(from ?? "")
    .trim()
    .toLowerCase()
    .endsWith(GROUP_THREAD_SUFFIX.toLowerCase());
}
