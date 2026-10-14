import type { DialogSelectOptions } from '@opencode/plugin/tui/context';
import { z } from 'zod';
import { SessionID, Summary, type ArchiveSummary } from './schema.ts';

export const restorePickerMetadataKey = 'simpod.session-restore.archives';
export const RestorePickerArchives = z.array(Summary).min(1);
export const restoreResultMetadataKey = 'simpod.session-restore.result';
export const RestorePickerResult = z.strictObject({
  rootSessionID: SessionID,
  sessionIDs: z.array(SessionID).min(1),
  message: z.string(),
});

export function restorePickerOptions(
  archives: ArchiveSummary[],
): DialogSelectOptions<string> {
  const text = new Map(
    archives.map((archive) => [
      archive.id,
      `${archive.title} ${archive.rootSessionID} ${archive.id}`.toLowerCase(),
    ]),
  );
  return {
    title: 'Restore session archive',
    placeholder: 'Search titles, root session IDs, or archive IDs',
    options: archives
      .toSorted((left, right) => right.createdAt - left.createdAt)
      .map((archive) => ({
        title: archive.title || 'Untitled session',
        value: archive.id,
        description: `${archive.sessionCount} session${archive.sessionCount === 1 ? '' : 's'}`,
        footer: new Date(archive.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      })),
    search: (query, options) => {
      const terms = query.toLowerCase().trim().split(/\s+/);
      return options.filter((option) => {
        const candidate = text.get(option.value) ?? '';
        return terms.every((term) => candidate.includes(term));
      });
    },
  };
}
