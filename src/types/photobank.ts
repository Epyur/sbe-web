/** Типы Фотобанка — зеркало sbe-photobank/src/types/photobank.ts (только то,
 * что нужно read-only+соцслой веб-порталу; без полей локального кэша плагина). */

export interface PhotoFolder {
  id: number;
  name: string;
  parent_id: number;
  owner_email: string;
  limited: boolean;
  created_at: string;
  updated_at: string;
}

export interface PhotoItem {
  id: number;
  folder_id: number;
  title: string;
  description: string;
  tags: string[];
  custom: Record<string, unknown>;
  file_key: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  kind: string;
  width: number;
  height: number;
  duration: number;
  thumb_key: string;
  author_email: string;
  location: string;
  download_count: number;
  likes_count: number;
  created_at: string;
  updated_at: string;
}

export interface PhotoComment {
  id: number;
  photo_id: number;
  author_email: string;
  text: string;
  created_at: string;
}

export interface PullResponse {
  photos: PhotoItem[];
}

export interface MyPermission {
  email: string;
  role: string;
  hasAccess: boolean;
}
