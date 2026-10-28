# Ümraniye Şampiyonları

Servis takibi, sevkiyat ve şubeler arası ürün talepleri için anlık çalışan kanban uygulaması. Telefona uygulama olarak eklenebilir.

- **Arayüz:** `public/index.html` — tek HTML dosyası (stil ve kod içinde).
- **Sunucu:** `server.js` — Node.js + PostgreSQL. Bir ekranda yapılan değişiklik açık olan tüm ekranlara anında gider.
- **Giriş:** Herkes kendi kullanıcı adı ve şifresiyle girer. Yönetici, kullanıcıları *Tanımlar ve Ayarlar* sayfasından ekler.

## Render'da yayınlama

1. Bu klasörü GitHub'da bir depoya yükleyin.
2. Render'da bir **PostgreSQL** veritabanı oluşturun. Veritabanı sayfasından *Internal Database URL* adresini kopyalayın.
3. Render'da yeni bir **Web Service** oluşturup depoyu seçin:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
4. Web servisine şu ortam değişkenlerini girin:

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | 2. adımda kopyalanan adres |
| `ADMIN_USERNAME` | İlk yönetici kullanıcı adı (ör. `emirhan`) |
| `ADMIN_PASSWORD` | İlk yönetici şifresi (en az 6 karakter) |
| `ADMIN_NAME` | Yöneticinin görünen adı |
| `DB_SCHEMA` | *(İsteğe bağlı)* Tabloların tutulacağı şema, varsayılan `servis`. Aynı veritabanını kullanan başka projelere dokunulmaz. |
| `APP_URL` | Sitenin adresi; e-postalardaki bağlantılar için |
| `BIRD_API_KEY` | Bird e-posta API anahtarı (kayıt doğrulama, şifre sıfırlama, talep e-postaları, günlük rapor) |
| `MAIL_FROM` | Gönderen adres. Doğrulanmış alan adı yoksa `onboarding@messagebird.dev` yalnızca Bird çalışma alanı üyelerine ulaşır |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | Telefon bildirimleri (`npx web-push generate-vapid-keys`) |
| `SEED_JSON` | *(İsteğe bağlı)* Veritabanı boşken bir kez içe aktarılacak başlangıç verileri |
| `API_SHIELD_KEY` | *(Önerilir)* API kalkanı anahtarı (32 baytlık base64). Verilmezse her derlemede yeni anahtar üretilir ve açık sekmeler güncellemeden sonra kendini yeniler |

İlk açılışta tablolar otomatik kurulur ve yönetici hesabı oluşturulur.

## Yerelde çalıştırma

```bash
npm install
DATABASE_URL=postgres://kullanici@localhost:5432/servis ADMIN_USERNAME=admin ADMIN_PASSWORD=degistir123 npm start
```

Ardından tarayıcıda http://localhost:3000 adresini açın.

## Derleme ve karartma

`npm install` sonunda `build.js` otomatik çalışır ve `public/` klasöründen `dist/` üretir:

- Uygulama betiği javascript-obfuscator ile karartılır, CSS küçültülür, dosyalar brotli/gzip ile önceden sıkıştırılır.
- API kalkanı anahtarı betiğe gömülür; uygulamanın istek, yanıt ve canlı olay trafiği bu anahtarla kodlanır.
- Sunucu `dist/` varsa onu sunar. Kaynak dosyalarla denemek için `SERVE_SOURCE=1 npm start`, derlemeyi atlamak için `SKIP_BUILD=1 npm install`.

Kaynak kod `public/` altında okunur kalır; depoyu herkese açık tutmayın.

## Notlar

- Render'ın ücretsiz web servisi 15 dakika kullanılmadığında uykuya geçer; uyandıktan sonraki ilk açılış yaklaşık bir dakika sürer.
- Render'ın ücretsiz PostgreSQL veritabanı 30 gün sonra silinir. Kalıcı kullanım için ücretli plana geçin veya verileri Excel ile dışa aktarın.
- Fotoğraf ve PDF ekleri veritabanında saklanır (dosya başına en fazla 15 MB).
