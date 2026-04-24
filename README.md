<div align="center">

<img src="icons/icon128.png" width="80" height="80" alt="AD'IOS icon"/>

# AD'IOS

### *Say goodbye to ads.*

**Extension Chrome/Opera/Edge qui détecte et élimine les publicités YouTube**  
Instantanément. Localement. Sans base de données externe.

[![Version](https://img.shields.io/badge/version-2.0.0-ff3d3d?style=flat-square)](https://github.com/cazo74/adios/releases)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-222?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/)
[![License MIT](https://img.shields.io/badge/license-MIT-2ecc71?style=flat-square)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-88+-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![Opera](https://img.shields.io/badge/Opera-74+-FF1B2D?style=flat-square&logo=opera&logoColor=white)](https://addons.opera.com)
[![Edge](https://img.shields.io/badge/Edge-88+-0078D7?style=flat-square&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons)

</div>

---

## Pourquoi AD'IOS ?

YouTube diffuse des pubs de plus en plus agressives — pré-rolls non-skippables, bannières mid-video, overlays intrusifs. Les bloqueurs réseau classiques sont efficaces mais de plus en plus ciblés par YouTube.

**AD'IOS prend une approche différente** : il agit directement sur le player, comme le ferait un utilisateur rapide — sans bloquer le réseau, sans liste de filtres à maintenir, sans dépendance externe.

---

## Moteur de détection — 4 layers

AD'IOS croise **4 sources d'information indépendantes**. Une pub n'est confirmée que si **≥ 2 signaux** sont positifs simultanément — ce qui élimine les faux positifs.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CSS / DOM                                            │
│  8+ sélecteurs : .ad-showing, .ad-interrupting, skip buttons,  │
│  overlay containers, ad badges, companion ads...                │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2 — YouTube Player API interne                           │
│  getAdState() + getVideoData() directement sur #movie_player   │
│  → immunisé aux renommages de classes CSS                       │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3 — Native Video Events                                  │
│  Écoute "playing" et "timeupdate" sur <video>                   │
│  → détecte les pubs sans mutation DOM notable                   │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 4 — PerformanceObserver                                  │
│  Surveille les URLs de ressources chargées                      │
│  → détecte googlevideo, doubleclick, /api/stats/ads...          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stratégies d'action — cascade intelligente

Quand une pub est confirmée, AD'IOS tente les stratégies dans l'ordre suivant :

| # | Stratégie | Cas d'usage | Résultat |
|---|-----------|-------------|---------|
| 🟢 1 | **Click Skip button** | Pub skippable après 5s | Instantané |
| 🟢 2 | **Close overlay** | Bannière / display ad | Instantané |
| 🟡 3 | **Fast-forward** | Pub avec durée connue | `currentTime = duration` |
| 🟡 4 | **Turbo ×16** | Pub non-skippable 15–20s | Mute + `playbackRate = 16` |
| 🔴 5 | **Reload SPA** | Last resort | Max 4 tentatives |

**Backoff exponentiel** entre tentatives : `500ms → 1s → 2s → 4s`  
**Délai naturel** avant action : `400–650ms` aléatoire (anti-pattern-detect)

---

## Robustesse

- ✅ **SPA YouTube** — gestion `yt-navigate-start/finish` + patch `history.pushState`
- ✅ **Verrou anti-concurrence** — un seul handler actif à la fois
- ✅ **Auto-restauration** — son et vitesse remis à la normale après pub
- ✅ **MutationObserver debounced** — 200ms, scope limité à `#movie_player`
- ✅ **Zéro setInterval** — event-driven uniquement
- ✅ **Zéro requête réseau** — 100% local

---

## Permissions

| Permission | Pourquoi |
|---|---|
| `storage` | Stats locales (compteur, journal des pubs) |
| `host_permissions: *.youtube.com` | Injection du content script |

**Aucun** accès réseau. **Aucune** liste de filtres. **Aucune** donnée collectée.

---

## Installation

### Mode développeur (immédiat)

```bash
# 1. Clone le repo
git clone https://github.com/cazo74/adios.git

# 2. Ouvre ton navigateur
# Chrome → chrome://extensions
# Opera  → opera://extensions
# Edge   → edge://extensions

# 3. Active "Mode développeur"
# 4. Clique "Charger l'extension non empaquetée"
# 5. Sélectionne le dossier adios/
```

### Chrome Web Store
> 🔜 Publication en cours de review

---

## Structure du projet

```
adios/
├── manifest.json       # Manifest V3 — permissions minimales
├── content.js          # Moteur principal — 4 layers de détection
├── popup.html          # Interface popup
├── popup.css           # Styles — dark theme, fonts système
├── popup.js            # Logique popup + stats temps réel
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Compatibilité

| Navigateur | Supporté | Version min |
|---|---|---|
| Google Chrome | ✅ | 88+ |
| Opera | ✅ | 74+ |
| Microsoft Edge | ✅ | 88+ |
| Firefox | ⚠️ | MV3 partiel (non testé) |
| Safari | ❌ | MV3 non supporté |

---

## Contribuer

Les sélecteurs CSS YouTube changent régulièrement. Si une pub passe à travers :

1. Ouvre la console (`F12`) sur YouTube pendant la pub
2. Cherche les logs `AD'IOS` pour voir quels signaux ont été détectés
3. Ouvre une issue avec le screenshot de la console

Les PRs sont les bienvenues pour :
- Nouveaux sélecteurs CSS découverts
- Amélioration du Player API layer
- Support Firefox

---

## Changelog

### v2.0.0
- Ajout Layer 2 — Player API interne YouTube
- Ajout Layer 3 — Video Events natifs
- Ajout Layer 4 — PerformanceObserver
- Nouvelle stratégie Turbo ×16 pour pubs non-skippables
- Backoff exponentiel entre tentatives
- Nouveau nom : **AD'IOS**

### v1.0.0
- Version initiale — détection CSS + MutationObserver

---

## License

MIT © 2026 2ktel

---

<div align="center">

**AD = publicité &nbsp;·&nbsp; ' = le skip &nbsp;·&nbsp; IOS = adios**

*Built with splif in Haute-Savoie, France* pour le monde entier ! 

</div>
