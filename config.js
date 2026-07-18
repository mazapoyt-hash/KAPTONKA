export const CONFIG = {
  appName: 'КАРТОНКА',
  tagline: 'У кожної мирної акції має бути тил.',
  description:
    'Платформа взаємодопомоги для мирних акцій: створи точку підтримки, знайди потрібне поруч або закрий конкретну потребу.',

  publicAppUrl: 'https://mazapoyt-hash.github.io/KAPTONKA/',

  // Заповни після створення проєкту в Supabase: Settings → API.
  // Публічний anon key можна використовувати у браузері, якщо RLS налаштовано SQL-файлом із цього проєкту.
  supabaseUrl: 'https://fdguozstlkbtlgbgxfha.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkZ3VvenN0bGtidGxnYmd4ZmhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMzY3NzAsImV4cCI6MjA5OTkxMjc3MH0.8hMEIpas5KdO5Au2GgX7NdgAw5ozasnlgv9VRvQJM60',
  photoBucket: 'point-photos',

  defaultCity: 'Усі міста',
  refreshIntervalMs: 30000,
  absenceReportsToHide: 20,
  maxPhotoSizeMb: 5,
  dataVersion: '3.0.0',

  defaultMapCenter: [50.4501, 30.5234],
  defaultMapZoom: 13,

  privacyNote:
    'КАРТОНКА не показує імена власників точок. Координати публікуються лише для створеної точки підтримки. Не фотографуй обличчя людей без їхньої згоди.',
};
