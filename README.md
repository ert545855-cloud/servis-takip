# Servis Takip Panosu

Arıza kayıtları ve fatura takibi için anlık çalışan kanban panosu.

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
| `SEED_JSON` | *(İsteğe bağlı)* Veritabanı boşken bir kez içe aktarılacak başlangıç verileri |

İlk açılışta tablolar otomatik kurulur ve yönetici hesabı oluşturulur.

## Yerelde çalıştırma

```bash
npm install
DATABASE_URL=postgres://kullanici@localhost:5432/servis ADMIN_USERNAME=admin ADMIN_PASSWORD=degistir123 npm start
```

Ardından tarayıcıda http://localhost:3000 adresini açın.

## Notlar

- Render'ın ücretsiz web servisi 15 dakika kullanılmadığında uykuya geçer; uyandıktan sonraki ilk açılış yaklaşık bir dakika sürer.
- Render'ın ücretsiz PostgreSQL veritabanı 30 gün sonra silinir. Kalıcı kullanım için ücretli plana geçin veya verileri Excel ile dışa aktarın.
- Fotoğraf ve PDF ekleri veritabanında saklanır (dosya başına en fazla 15 MB).
