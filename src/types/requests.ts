/** Типы «Заявок на испытания» — зеркало sbe-requests/src/types/requests.ts
 * (без sync_status/локального кэша, тех же полей достаточно для admin-уровня веба). */

export interface Lab {
  id: number;
  code: string;
  name: string;
  description: string;
  type: string;
  parent_lab_id: number;
}

export interface LabMethod {
  id: number;
  code: string;
  name: string;
  lab_ids: number[];
  description: string;
  determinable_indicators: string[];
}

export interface ObjectCharacteristics {
  ekn?: string;
  batch_number?: number;
  sample_id?: string;
  sample_type?: string;
  thickness_mm?: string;
  target_indicators?: Record<string, string>;
  ekn_snapshot?: {
    name: string;
    thickness: string;
    sto_number: string;
    sto_name: string;
    fire_groups?: {
      flame_group?: string;
      flammability_gr?: string;
      flame_spread_gr?: string;
    };
  };
}

export interface LabObject {
  id: number;
  name: string;
  description: string;
  characteristics: ObjectCharacteristics;
  created_at: string;
  updated_at: string;
}

export interface LabProject {
  id: number;
  parent_id: number;
  code: string;
  name: string;
  description: string;
  is_ekn: boolean;
  group_id: number;
  owner_email: string;
  /** Триггеры почтового приёма: заявка без своего ЕКН-автопроекта попадает в
   * этот проект, если её ЕКН/отправитель совпал. Пусто — вне авто-маршрутизации. */
  mail_trigger_ekn: string;
  mail_trigger_sender: string;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  email: string;
  role: string;
}

export interface LabGroup {
  id: number;
  name: string;
  owner_email: string;
  members: GroupMember[];
}

export interface RequestFile {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
}

export interface LabRequest {
  id: number;
  number_seq: number;
  number_year: number;
  title: string;
  description: string;
  object_id: number;
  project_id: number;
  group_id: number;
  owner_email: string;
  status: string;
  priority: string;
  test_purpose: string;
  ekn: string;
  external_id: string;
  method_id: number;
  lab_id: number;
  customer_number: string;
  lab_number: string;
  files: RequestFile[];
  created_at: string;
  updated_at: string;
  completed_at: string;
}

export interface PullResponse {
  requests: LabRequest[];
  projects: LabProject[];
  groups: LabGroup[];
  labs: Lab[];
  methods: LabMethod[];
  objects: LabObject[];
}

export interface PushResponse {
  inserted: number;
  updated: number;
  created: Array<{ client_id: number; group_key?: string; request: LabRequest }>;
}

export interface UploadFileResponse {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
  request_id: number;
}

export interface ProtocolResponse {
  html: string;
  docx_base64: string;
  generated_at: string;
}

export interface AuditLogEntry {
  id: number;
  request_id: number;
  kind: 'status' | 'result_created' | 'result_updated';
  who: string;
  created_at: string;
  old_status?: string;
  new_status?: string;
  method_id?: number;
  series_num?: number;
  values_before?: Record<string, unknown>;
  values_after?: Record<string, unknown>;
}

export interface MyPermission {
  email: string;
  role: string;
  /** Реальная роль без учёта активного «просмотра от лица роли» (см. store/viewAs.ts). */
  real_role: string;
  hasAccess: boolean;
}
