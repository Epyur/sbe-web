/**
 * Белый список read-only GET-эндпоинтов сервисов, доступных агенту через
 * describe_api/call_api — путь для данных, которым не посвящён отдельный
 * get_*-тул (справочники ЛИМС, доп. срезы фотобанка и т.п.), без необходимости
 * писать новый тул под каждое поле. Права по-прежнему проверяет сервер
 * (JWT app_id, requirePerm) — манифест только сужает набор эндпоинтов, которые
 * агент вообще может вызвать (не даёт достучаться до произвольного/неизвестного
 * пути и до непрочитанных методов POST/PATCH/DELETE).
 *
 * Пополнять по мере необходимости — добавить запись сюда дешевле, чем писать
 * отдельный get_*-тул с ручным маппингом полей.
 */

export interface ApiEndpointDef {
  appId: string;
  path: string;
  /** Имена {подстановок} в path, которые нужно передать в path_params. */
  pathParams?: string[];
  /** Имя параметра запроса → короткое описание. */
  query?: Record<string, string>;
  description: string;
}

export const API_MANIFEST: ApiEndpointDef[] = [
  // ---- lab-service (ЛИМС / заявки на испытания) ----
  { appId: 'lab', path: '/api/lab/labs', description: 'Справочник лабораторий: id, code, name, description, type, parent_lab_id.' },
  { appId: 'lab', path: '/api/lab/methods', description: 'Справочник методов испытаний: id, code, name, lab_ids (какие лаборатории выполняют), description, determinable_indicators.' },
  { appId: 'lab', path: '/api/lab/projects', description: 'Дерево проектов заявок: id, parent_id, code, name, is_ekn, group_id, owner_email.' },
  { appId: 'lab', path: '/api/lab/objects', description: 'Объекты исследования (образцы): id, name, characteristics (ЕКН, партия, толщина и т.п.), created_at.' },
  { appId: 'lab', path: '/api/lab/groups', description: 'Группы видимости заявок: id, name, owner_email, members (email+role).' },
  { appId: 'lab', path: '/api/lab/equipment', description: 'Оборудование лабораторий.' },
  { appId: 'lab', path: '/api/lab/equipment/{id}/calibrations', pathParams: ['id'], description: 'История поверок/калибровок единицы оборудования.' },
  { appId: 'lab', path: '/api/lab/equipment/{id}/methods', pathParams: ['id'], description: 'Методы, привязанные к единице оборудования.' },
  { appId: 'lab', path: '/api/lab/equipment/{id}/documents', pathParams: ['id'], description: 'Документы (сертификаты и т.п.), приложенные к единице оборудования.' },
  { appId: 'lab', path: '/api/lab/equipment-links', description: 'Все связи оборудование↔метод сразу по всем единицам (не по одной).' },
  { appId: 'lab', path: '/api/lab/method-equipment', description: 'Все связи метод↔оборудование сразу по всем методам.' },
  { appId: 'lab', path: '/api/lab/inventors', description: 'Испытатели лабораторий.' },
  { appId: 'lab', path: '/api/lab/lab-members', description: 'Участники лабораторий (роли lab_admin/inventor и т.п. по лабораториям).' },
  { appId: 'lab', path: '/api/lab/requests/{id}/results', pathParams: ['id'], description: 'Сырые результаты испытания по заявке (серии измерений).' },
  { appId: 'lab', path: '/api/lab/requests/{id}/results/aggregated', pathParams: ['id'], description: 'Агрегированные (посчитанные) результаты испытания по заявке.' },
  { appId: 'lab', path: '/api/lab/requests/{id}/audit-log', pathParams: ['id'], description: 'Журнал изменений конкретной заявки.' },
  { appId: 'lab', path: '/api/lab/requests/{id}/sent-emails', pathParams: ['id'], description: 'Письма, отправленные по конкретной заявке.' },

  // ---- photo-service (Фотобанк) ----
  { appId: 'photo', path: '/api/photo/search', query: { q: 'поисковая строка (пусто — не искать по тексту)', folder_id: 'id папки, ограничить поиск ей', kind: 'image/video/raw' }, description: 'Полнотекстовый поиск фото на сервере — точнее и легче, чем выгружать всё через get_photos и фильтровать вручную.' },
  { appId: 'photo', path: '/api/photo/folders', description: 'Дерево папок фотобанка (id, name, parent_id).' },
  { appId: 'photo', path: '/api/photo/favorites', description: 'Избранные фото текущего пользователя.' },
  { appId: 'photo', path: '/api/photo/recent', description: 'Недавно просмотренные/добавленные фото.' },
  { appId: 'photo', path: '/api/photo/photos/{id}/comments', pathParams: ['id'], description: 'Комментарии к конкретному фото.' },
];
