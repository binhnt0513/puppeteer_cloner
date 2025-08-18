# Puppeteer Docker


---

## 🐳 Build Docker 

```
docker compose up -d --build
```

## ▶️ Run script
```
docker compose exec cloner pnpm start https://www.example.com/ --collect-only --max-depth=6 --max-pages=100

```