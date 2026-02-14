# 網路 IP 掃描 - Cockpit 外掛

[English README](README.md)

一個 [Cockpit](https://cockpit-project.org/) 網頁管理介面外掛，用於掃描和監控區域網路上的活躍裝置。

![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss)
![Cockpit](https://img.shields.io/badge/Cockpit-外掛-0066CC)

## 功能特色

- 自動偵測網路介面與子網路計算
- 使用 `fping` 進行主動掃描（未安裝時自動改用 `ping`）
- MAC 位址裝置去重（同一 MAC 的 IPv4 + IPv6 視為一台裝置）
- 狀態篩選器（可連線 / 已過期），以顏色區分
- IPv4 / IPv6 協定切換
- 即時搜尋（依 IP、MAC 或狀態）
- 掃描進度條與階段指示
- LocalStorage 快取介面選擇與掃描結果
- 快取資料超過 5 分鐘自動重新掃描
- 多語系支援（英文、繁體中文），跟隨 Cockpit 語言設定

## 系統需求

- 已安裝 [Cockpit](https://cockpit-project.org/) 的 Linux 伺服器
- 選用：`fping`（可加速掃描）

```bash
# Ubuntu / Debian
sudo apt install cockpit fping

# RHEL / Fedora
sudo dnf install cockpit fping
```

## 安裝方式

本專案透過 CI 自動建置，使用者不需要自行編譯。

```bash
git clone https://github.com/<your-username>/ip-scanner.git
cd ip-scanner
sudo make install
```

安裝完成後，開啟瀏覽器前往 Cockpit（預設：`https://<伺服器IP>:9090`），在側邊欄的「工具」區域即可看到 **網路 IP 掃描**。

## 解除安裝

```bash
sudo make uninstall
```

## 開發

如果想修改原始碼：

```bash
# 安裝相依套件
npm install

# 開發伺服器（熱重載）
npm run dev

# 正式版建置
npm run build
```

### 專案結構

```
ip-scanner/
├── src/
│   ├── App.vue              # 主應用程式元件
│   ├── main.js              # Vue 進入點
│   ├── style.css            # Tailwind CSS 引入
│   ├── i18n.js              # 多語系模組（語言偵測 + 翻譯）
│   └── locales/
│       ├── en.json           # 英文翻譯
│       └── zh-TW.json        # 繁體中文翻譯
├── dist/
│   └── index.html            # 建置產出的單一檔案（由 CI 自動產生）
├── po.manifest.zh_TW.js      # Cockpit 側邊欄標題翻譯
├── manifest.json              # Cockpit 外掛清單
├── index.html                 # Vite 入口 HTML
├── vite.config.js             # Vite + Tailwind + SingleFile 設定
├── Makefile                   # install / uninstall 目標
└── .github/workflows/
    └── build.yml              # CI：推送時自動建置
```

### 運作原理

1. **介面偵測**：透過 `cockpit.spawn()` 執行 `ip -j link` / `ip -j addr`，列出作用中的網路介面並計算子網路。
2. **掃描**：執行 `fping -a -g <子網路>` 對所有主機進行 ping。若未安裝 `fping`，則自動改用並行 `ping` 迴圈。
3. **鄰居收集**：等待 2 秒讓 ARP 表穩定後，透過 `ip -j neigh show dev <介面>` 讀取 ARP/NDP 表，並依 MAC 位址合併。
4. **快取**：將掃描結果存入 `localStorage`。重新載入頁面時還原快取資料，若快取超過 5 分鐘則自動重新掃描。
5. **多語系**：語言偵測優先順序為 `CockpitLang` cookie > `cockpit.language` > `navigator.language`，預設使用英文。

## 技術堆疊

- [Vue 3](https://vuejs.org/)（Composition API，`<script setup>`）
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Vite](https://vite.dev/)
- [vite-plugin-singlefile](https://github.com/niccoloraspa/vite-plugin-singlefile)（將所有 JS/CSS 內嵌至單一 HTML）

## 授權

MIT
