'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ProjectDetail } from '@/lib/api/endpoints/projects';
import {
  previewBdBoard,
  type BdStateOption,
  type StateCategory,
} from '@/lib/api/endpoints/importExport';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SettingsCard from '@/components/common/page/SettingsCard';
import SettingsSection from '@/components/common/page/SettingsSection';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import { useCreateImportJob } from '../../services/settings.service';
import SettingsImportExportStateOverrideRow from './SettingsImportExportStateOverrideRow';

// The bd (Beads) source on the Import tab. No credential and no board address are
// entered here: the server reads the bd board its operator configured
// (BD_IMPORT_BOARD_ROOT), and this form shows what that board will import and
// carries the mapping choices into the job.
export default function SettingsImportExportBd({ project }: { project: ProjectDetail }) {
  const t = useTranslations('settings.importExport');
  const projectKey = project.project.ref;
  const board = useQuery({
    queryKey: ['bdBoardPreview', projectKey],
    queryFn: () => previewBdBoard(projectKey),
  });
  const createJob = useCreateImportJob(projectKey);
  const [sourceName, setSourceName] = useState('');
  const [overrides, setOverrides] = useState<Record<string, StateCategory>>({});

  function setOverride(stateId: string, defaultCategory: StateCategory, category: StateCategory) {
    setOverrides((prev) => {
      if (category === defaultCategory) {
        const { [stateId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [stateId]: category };
    });
  }

  async function start() {
    try {
      await createJob.mutateAsync({
        source: 'bd',
        // The tree cap is not a job choice: every bd import is rig-targeted, so
        // the server reader derives the depth (uncapped) itself.
        ...(sourceName.trim() !== '' ? { sourceName: sourceName.trim() } : {}),
        ...(Object.keys(overrides).length > 0 ? { stateOverrides: overrides } : {}),
      });
      toast.success(t('importStarted'));
    } catch {
      // Surfaced by the global mutation error toast; nothing local to do.
    }
  }

  if (board.isPending) {
    return (
      <SettingsSection title={t('title', { source: 'Beads' })} description={t('bd.hint')}>
        <SettingsCard className="p-6">
          <ListSkeleton rows={3} rowClassName="h-10" />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (board.isError || board.data == null) {
    return (
      <SettingsSection title={t('title', { source: 'Beads' })} description={t('bd.hint')}>
        <SettingsCard className="p-6">
          <p className="text-sm text-muted-foreground">{t('bd.notConfigured')}</p>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const states: BdStateOption[] = board.data.states;

  return (
    <SettingsSection title={t('title', { source: 'Beads' })} description={t('bd.hint')}>
      <SettingsCard className="space-y-6 p-6">
        <div className="text-sm text-muted-foreground">
          {t('bd.board')}: {board.data.cards}
        </div>

        {states.length > 0 && (
          <div className="space-y-2">
            <Label>{t('stateMapping')}</Label>
            <SettingsCard className="max-h-64 divide-y divide-border/60 overflow-y-auto">
              {states.map((state) => (
                <SettingsImportExportStateOverrideRow
                  key={state.id}
                  state={state}
                  value={overrides[state.id] ?? state.category}
                  onChange={(category) => setOverride(state.id, state.category, category)}
                />
              ))}
            </SettingsCard>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1">
            <Label htmlFor="bd-source-name">{t('bd.sourceName')}</Label>
            <Input
              id="bd-source-name"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('bd.sourceNameHint')}</p>
          </div>
        </div>

        <Button disabled={createJob.isPending} onClick={() => void start()}>
          {createJob.isPending ? t('starting') : t('startImport')}
        </Button>
      </SettingsCard>
    </SettingsSection>
  );
}
