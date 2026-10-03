/** 前端只做编辑与展示；所有计算在后端，这里只取数。 */

export interface FieldError {
  field: string;
  message: string;
}

export interface Species {
  id: number;
  name: string;
}

export interface SourcedCell<T> {
  value: T;
  source: 'base' | 'override' | null;
}

export interface EffectiveStageRow {
  stageNo: number;
  mcThresholdPct: SourcedCell<number | null>;
  dryBulbC: SourcedCell<number>;
  wetBulbC: SourcedCell<number>;
}

export interface BaseStageRow {
  stageNo: number;
  mcThresholdPct: number | null;
  dryBulbC: number;
  wetBulbC: number;
}

export interface VersionInfo {
  id: number;
  speciesId: number;
  version: number;
  status: 'draft' | 'published';
  note: string | null;
  publishedAt: string | null;
  baseStages?: BaseStageRow[];
}

export interface Grade {
  id: number;
  speciesId: number;
  code: string;
  label: string;
}

export interface Preview {
  draft: VersionInfo;
  grades: Grade[];
  baseStages: BaseStageRow[];
  effectiveStages: EffectiveStageRow[];
}

export interface KilnOverview {
  id: number;
  name: string;
  running: boolean;
  batch: { id: number; startedAt: string; speciesId: number; versionId: number } | null;
  currentStageNo: number | null;
  currentMcPct: number | null;
  latestEmcPct: number | null;
  latestRhPct: number | null;
  stageCount: number;
}

export interface Transition {
  stageNo: number;
  enteredAt: string;
  triggerRecordNo: number | null;
}

export interface McPoint {
  recordNo: number | null;
  recordedAt: string;
  kind: 'psychro' | 'weight' | 'anchor';
  mcPct: number;
  emcPct: number | null;
  rhPct: number | null;
  dryBulbC: number | null;
  wetBulbC: number | null;
  weightG: number | null;
  stageNo: number;
}

export interface KilnDetail {
  kilnId: number;
  running: boolean;
  batch: {
    id: number;
    startedAt: string;
    speciesId: number;
    versionId: number;
    thicknessGradeId: number | null;
    initialWeightG: number;
    initialMcPct: number;
  } | null;
  timeline: {
    currentStageNo: number;
    currentMcPct: number;
    latestEmcPct: number | null;
    latestRhPct: number | null;
    transitions: Transition[];
    points: McPoint[];
  } | null;
  stages: BaseStageRow[] | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors = (body as { errors?: FieldError[] }).errors ?? [
      { field: '', message: `请求失败 ${res.status}` },
    ];
    throw new ApiError(errors, res.status);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    public errors: FieldError[],
    public status: number,
  ) {
    super(errors.map((e) => `${e.field ? e.field + ': ' : ''}${e.message}`).join('；'));
    this.name = 'ApiError';
  }
}

export const api = {
  listSpecies: () => request<Species[]>('/api/species'),
  createSpecies: (name: string) =>
    request<Species>('/api/species', { method: 'POST', body: JSON.stringify({ name }) }),
  listVersions: (speciesId: number) =>
    request<VersionInfo[]>(`/api/species/${speciesId}/versions`),
  createDraft: (speciesId: number, note: string) =>
    request<VersionInfo>(`/api/species/${speciesId}/draft`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  saveStages: (speciesId: number, stages: BaseStageRow[]) =>
    request(`/api/species/${speciesId}/draft/stages`, {
      method: 'PUT',
      body: JSON.stringify({ stages }),
    }),
  listGrades: (speciesId: number) =>
    request<Grade[]>(`/api/species/${speciesId}/grades`),
  createGrade: (speciesId: number, code: string, label: string) =>
    request<Grade>(`/api/species/${speciesId}/grades`, {
      method: 'POST',
      body: JSON.stringify({ code, label }),
    }),
  saveOverrides: (speciesId: number, gradeCode: string, overrides: unknown[]) =>
    request(`/api/species/${speciesId}/draft/grades/${gradeCode}/overrides`, {
      method: 'PUT',
      body: JSON.stringify({ overrides }),
    }),
  preview: (speciesId: number, gradeCode: string | null) =>
    request<Preview>(
      `/api/species/${speciesId}/draft/preview${gradeCode ? `?grade=${encodeURIComponent(gradeCode)}` : ''}`,
    ),
  effective: (versionId: number, gradeCode: string | null) =>
    request<{ baseStages: BaseStageRow[]; effectiveStages: EffectiveStageRow[] }>(
      `/api/versions/${versionId}/effective${gradeCode ? `?grade=${encodeURIComponent(gradeCode)}` : ''}`,
    ),
  publish: (speciesId: number) =>
    request<VersionInfo>(`/api/species/${speciesId}/publish`, { method: 'POST' }),

  listKilns: () => request<KilnOverview[]>('/api/kilns'),
  kiln: (id: number) => request<KilnDetail>(`/api/kilns/${id}`),
  startBatch: (kilnId: number, payload: Record<string, unknown>) =>
    request(`/api/kilns/${kilnId}/batches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  finishBatch: (kilnId: number) =>
    request(`/api/kilns/${kilnId}/finish`, { method: 'POST' }),
  submitReading: (payload: Record<string, unknown>) =>
    request('/api/readings', { method: 'POST', body: JSON.stringify(payload) }),
};
