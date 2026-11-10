#!/usr/bin/env python3
"""
Bot de ofertas de Mercado Libre México -> Telegram.

Revisa tiendas oficiales, búsquedas o categorías de Mercado Libre, guarda el
historial de precios en SQLite y te avisa por Telegram cuando hay una oferta,
un cupón o una bajada de precio, con el precio final ya calculado.

Uso rápido (ver README.md):
    python bot.py               -> una revisión (lo que corre el Programador de tareas)
    python bot.py --continuo    -> se queda corriendo y revisa cada N minutos
    python bot.py --vincular    -> conecta tu chat de Telegram con el bot
    python bot.py --login       -> abre el navegador para que inicies sesión en Mercado Libre
    python bot.py --prueba      -> manda un mensaje de prueba a Telegram
    python bot.py --simular     -> revisa todo pero imprime los avisos en vez de mandarlos
"""

from __future__ import annotations

import argparse
import html
import json
import logging
import os
import random
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
DB_PATH = BASE / "datos.db"
ENV_PATH = BASE / ".env"
PERFIL_DIR = BASE / "perfil_navegador"
LOG_PATH = BASE / "bot.log"
LOCK_PATH = BASE / ".bot.lock"

SITIO = "https://www.mercadolibre.com.mx"
LISTADO = "https://listado.mercadolibre.com.mx"

# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #


def preparar_consola() -> None:
    """Evita errores con emojis/acentos en la consola de Windows (o sin consola con pythonw)."""
    for flujo in (sys.stdout, sys.stderr):
        try:
            flujo.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def configurar_log() -> logging.Logger:
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
            LOG_PATH.replace(LOG_PATH.with_suffix(".log.1"))
    except OSError:
        pass
    log = logging.getLogger("bot")
    log.setLevel(logging.INFO)
    if not log.handlers:
        fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
        fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
        if sys.stdout is not None:
            sh = logging.StreamHandler(sys.stdout)
            sh.setFormatter(fmt)
            log.addHandler(sh)
    return log


log = logging.getLogger("bot")


def ahora() -> str:
    return datetime.now().isoformat(timespec="seconds")


def cargar_env() -> None:
    """Lee el archivo .env (CLAVE=valor) sin dependencias externas."""
    if not ENV_PATH.exists():
        return
    for linea in ENV_PATH.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        clave, valor = clave.strip(), valor.strip().strip('"').strip("'")
        if valor and not os.environ.get(clave):
            os.environ[clave] = valor


def guardar_env(clave: str, valor: str) -> None:
    lineas = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    nueva = f"{clave}={valor}"
    for i, linea in enumerate(lineas):
        if linea.split("=", 1)[0].strip() == clave:
            lineas[i] = nueva
            break
    else:
        lineas.append(nueva)
    ENV_PATH.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    os.environ[clave] = valor


def cargar_config() -> dict:
    if not CONFIG_PATH.exists():
        sys.exit("No encontré config.json junto a bot.py.")
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"config.json tiene un error de formato (línea {e.lineno}, columna {e.colno}): {e.msg}")


def guardar_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sin_acentos(texto: str) -> str:
    texto = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in texto if not unicodedata.combining(c)).lower()


def a_numero(texto: str) -> float:
    """'1,299' -> 1299.0 ; '207.03' -> 207.03 (formato México)."""
    limpio = re.sub(r"[^\d.,]", "", texto or "").replace(",", "")
    try:
        return float(limpio) if limpio else 0.0
    except ValueError:
        return 0.0


def pesos(valor: float | None) -> str:
    if valor is None:
        return "-"
    if abs(valor - round(valor)) < 0.005:
        return f"${valor:,.0f}"
    return f"${valor:,.2f}"


def limpiar_montos(texto: str) -> str:
    """'$ 207 . 03' -> '$207.03' (así sale el texto de las tarjetas)."""
    texto = re.sub(r"\$\s+", "$", texto or "")
    texto = re.sub(r"(\d)\s*([.,])\s*(\d)", r"\1\2\3", texto)
    return re.sub(r"\s+", " ", texto).strip()


def esc(texto) -> str:
    return html.escape(str(texto or ""), quote=False)


# --------------------------------------------------------------------------- #
# Telegram
# --------------------------------------------------------------------------- #


class Telegram:
    def __init__(self, token: str | None, chat_id: str | None, simular: bool = False):
        self.token = token
        self.chat_id = str(chat_id) if chat_id else None
        self.simular = simular

    def _api(self, metodo: str, datos: dict | None = None, timeout: int = 40) -> dict | list | None:
        if not self.token:
            raise RuntimeError("Falta TELEGRAM_TOKEN en .env")
        url = f"https://api.telegram.org/bot{self.token}/{metodo}"
        cuerpo = urllib.parse.urlencode(datos or {}).encode()
        for intento in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=cuerpo), timeout=timeout) as r:
                    resp = json.loads(r.read().decode())
                return resp.get("result")
            except urllib.error.HTTPError as e:
                detalle = e.read().decode(errors="replace")
                if e.code == 429:
                    espera = 5
                    try:
                        espera = json.loads(detalle)["parameters"]["retry_after"] + 1
                    except Exception:
                        pass
                    time.sleep(espera)
                    continue
                raise RuntimeError(f"Telegram {metodo} respondió {e.code}: {detalle[:300]}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                if intento == 2:
                    raise RuntimeError(f"No pude conectar con Telegram: {e}") from None
                time.sleep(3)
        return None

    def enviar(self, texto: str, chat_id: str | None = None) -> None:
        destino = chat_id or self.chat_id
        if self.simular:
            print("\n----- [Telegram simulado] -----\n" + re.sub(r"<[^>]+>", "", texto) + "\n")
            return
        partes, actual = [], ""
        for linea in texto.split("\n"):  # corta entre líneas para no romper etiquetas HTML
            if actual and len(actual) + len(linea) + 1 > 3900:
                partes.append(actual)
                actual = ""
            actual = f"{actual}\n{linea}" if actual else linea
        partes.append(actual)
        for parte in partes:
            self._api("sendMessage", {
                "chat_id": destino, "text": parte[:4096],
                "parse_mode": "HTML", "disable_web_page_preview": "true",
            })
            time.sleep(0.4)

    def enviar_foto(self, foto: str | None, texto: str) -> None:
        if self.simular or not foto or len(texto) > 1024:
            self.enviar(texto)
            return
        try:
            self._api("sendPhoto", {"chat_id": self.chat_id, "photo": foto, "caption": texto, "parse_mode": "HTML"})
            time.sleep(0.4)
        except RuntimeError as e:
            log.warning("No se pudo mandar la foto (%s); mando solo texto.", e)
            self.enviar(texto)

    def actualizaciones(self, offset: int | None, espera: int = 0) -> list:
        datos = {"timeout": espera, "allowed_updates": json.dumps(["message"])}
        if offset is not None:
            datos["offset"] = offset
        return self._api("getUpdates", datos, timeout=espera + 15) or []


# --------------------------------------------------------------------------- #
# Base de datos
# --------------------------------------------------------------------------- #


def abrir_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS productos (
            id TEXT PRIMARY KEY,
            monitor TEXT,
            titulo TEXT,
            url TEXT,
            imagen TEXT,
            primera_vez TEXT,
            ultima_vez TEXT,
            ultimo_precio REAL,
            ultimo_final REAL,
            minimo_final REAL,
            ultimo_aviso_final REAL,
            ultimo_aviso_fecha TEXT,
            cupones TEXT
        );
        CREATE TABLE IF NOT EXISTS historial (
            id TEXT,
            fecha TEXT,
            precio REAL,
            precio_final REAL
        );
        CREATE INDEX IF NOT EXISTS idx_historial_id ON historial(id);
        CREATE TABLE IF NOT EXISTS estado (
            clave TEXT PRIMARY KEY,
            valor TEXT
        );
    """)
    return db


def leer_estado(db: sqlite3.Connection, clave: str, defecto: str | None = None) -> str | None:
    fila = db.execute("SELECT valor FROM estado WHERE clave = ?", (clave,)).fetchone()
    return fila["valor"] if fila else defecto


def poner_estado(db: sqlite3.Connection, clave: str, valor) -> None:
    db.execute("INSERT INTO estado(clave, valor) VALUES(?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
               (clave, str(valor)))
    db.commit()


def avisado_hace_poco(db: sqlite3.Connection, clave: str, horas: float) -> bool:
    valor = leer_estado(db, clave)
    if not valor:
        return False
    try:
        return datetime.now() - datetime.fromisoformat(valor) < timedelta(hours=horas)
    except ValueError:
        return False


# --------------------------------------------------------------------------- #
# Lectura de Mercado Libre (Playwright)
# --------------------------------------------------------------------------- #

# Extrae las tarjetas de producto ("poly-card") que usa Mercado Libre en
# tiendas oficiales, búsquedas y categorías.
JS_TARJETAS = r"""
() => {
  const num = (el) => {
    if (!el) return null;
    const f = el.querySelector('.andes-money-amount__fraction');
    if (!f) return null;
    const c = el.querySelector('.andes-money-amount__cents');
    const n = parseInt(f.textContent.replace(/[^\d]/g, ''), 10);
    if (isNaN(n)) return null;
    return n + (c ? parseInt(c.textContent.replace(/[^\d]/g, ''), 10) / 100 : 0);
  };
  const txt = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  const vistos = new Set();
  const out = [];
  const tarjetas = document.querySelectorAll('.poly-card, li.ui-search-layout__item .ui-search-result__wrapper');
  for (const card of tarjetas) {
    const a = card.querySelector('a.poly-component__title, .poly-component__title a, a.ui-search-link, a[href*="MLM"]');
    if (!a) continue;
    const href = a.href;
    let id = (href.match(/wid=(MLM\d+)/) || [])[1] || (decodeURIComponent(href).match(/item_id:(MLM\d+)/) || [])[1];
    if (!id) { const m = href.match(/MLM-?(\d{6,})/); if (m) id = 'MLM' + m[1]; }
    if (!id || vistos.has(id)) continue;
    const precio = num(card.querySelector('.poly-price__current .andes-money-amount, .ui-search-price__second-line .andes-money-amount'));
    if (precio == null) continue;
    vistos.add(id);
    const cupones = new Set();
    card.querySelectorAll('[class*="coupon"]').forEach(e => { const t = txt(e); if (t) cupones.add(t); });
    card.querySelectorAll('span, div, p, label').forEach(e => {
      if (e.children.length === 0 && /cup[oó]n/i.test(e.textContent)) cupones.add(txt(e.parentElement) || txt(e));
    });
    const promos = new Set();
    card.querySelectorAll('.poly-price__installments, [class*="promotion"], [class*="highlight"], [class*="bank"]').forEach(e => {
      const t = txt(e); if (t && !/cup[oó]n/i.test(t)) promos.add(t);
    });
    const img = card.querySelector('img.poly-component__picture, img');
    out.push({
      id,
      titulo: txt(a),
      url: href.split('#')[0],
      precio,
      precio_anterior: num(card.querySelector('.andes-money-amount--previous')),
      etiqueta_descuento: txt(card.querySelector('.andes-money-amount__discount, .poly-price__disc-label')),
      cupones: [...cupones],
      promos: [...promos],
      envio: txt(card.querySelector('.poly-component__shipping')),
      vendedor: txt(card.querySelector('.poly-component__seller')),
      imagen: img ? (img.getAttribute('data-src') || img.src || null) : null,
    });
  }
  return out;
}
"""

# Página individual de producto (solo con sesión iniciada; selectores de la PDP).
JS_PRODUCTO = r"""
() => {
  const titulo = document.querySelector('h1.ui-pdp-title, h1');
  if (!titulo) return [];
  const num = (el) => {
    if (!el) return null;
    const f = el.querySelector('.andes-money-amount__fraction');
    if (!f) return null;
    const c = el.querySelector('.andes-money-amount__cents');
    return parseInt(f.textContent.replace(/[^\d]/g, ''), 10) + (c ? parseInt(c.textContent.replace(/[^\d]/g, ''), 10) / 100 : 0);
  };
  const txt = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
  let precio = num(document.querySelector('.ui-pdp-price__second-line .andes-money-amount'));
  if (precio == null) {
    const meta = document.querySelector('meta[itemprop="price"]');
    if (meta) precio = parseFloat(meta.content);
  }
  if (precio == null) return [];
  const u = decodeURIComponent(location.href);
  let id = (u.match(/item_id:(MLM\d+)/) || [])[1] || (u.match(/wid=(MLM\d+)/) || [])[1];
  if (!id) { const m = u.match(/MLM-?(\d{6,})/); if (m) id = 'MLM' + m[1]; }
  const cupones = new Set();
  document.querySelectorAll('[class*="coupon"]').forEach(e => { const t = txt(e); if (t && t.length < 160) cupones.add(t); });
  const promos = new Set();
  document.querySelectorAll('.ui-pdp-price__subtitles, [class*="payment-promotions"], [class*="promotions-pill"]').forEach(e => {
    const t = txt(e); if (t && t.length < 160 && !/cup[oó]n/i.test(t)) promos.add(t);
  });
  const img = document.querySelector('.ui-pdp-gallery__figure img, figure img');
  return [{
    id, titulo: txt(titulo), url: location.href.split('#')[0], precio,
    precio_anterior: num(document.querySelector('.ui-pdp-price__original-value')),
    etiqueta_descuento: txt(document.querySelector('.ui-pdp-price__second-line .andes-money-amount__discount')),
    cupones: [...cupones], promos: [...promos], envio: '', vendedor: '',
    imagen: img ? (img.getAttribute('data-zoom') || img.src) : null,
  }];
}
"""

JS_SIGUIENTE = r"""
() => {
  const a = document.querySelector(
    'li.andes-pagination__button--next:not(.andes-pagination__button--disabled) a, a.andes-pagination__link[title="Siguiente"]');
  return a ? a.href : null;
}
"""


class MuroLogin(Exception):
    """Mercado Libre pidió iniciar sesión para ver esta página."""


def es_muro_login(url: str) -> bool:
    return any(p in url for p in ("account-verification", "/lgz/", "/jms/mlm/"))


def url_de_monitor(m: dict) -> str:
    if m.get("url"):
        return m["url"].strip()
    if m.get("tienda"):
        return f"{SITIO}/tienda/{m['tienda'].strip().strip('/')}"
    if m.get("busqueda"):
        slug = re.sub(r"[^a-z0-9]+", "-", sin_acentos(m["busqueda"])).strip("-")
        return f"{LISTADO}/{slug}"
    raise ValueError(f"El monitor '{m.get('nombre')}' necesita 'tienda', 'busqueda' o 'url'.")


def canal_navegador(cfg: dict) -> str | None:
    canal = (cfg.get("navegador") or {}).get("canal", "auto")
    if canal in (None, "", "chromium"):
        return None
    if canal == "auto":
        return "msedge" if os.name == "nt" else None
    return canal


def abrir_navegador(pw, cfg: dict, visible: bool = False):
    opciones = dict(
        user_data_dir=str(PERFIL_DIR),
        headless=not visible,
        locale="es-MX",
        timezone_id="America/Mexico_City",
        viewport={"width": 1366, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )
    canal = canal_navegador(cfg)
    if canal:
        opciones["channel"] = canal
    try:
        contexto = pw.chromium.launch_persistent_context(**opciones)
    except Exception as e:
        if canal:
            log.warning("No pude abrir el navegador '%s' (%s). Intento con Chromium de Playwright.", canal, e)
            opciones.pop("channel")
            contexto = pw.chromium.launch_persistent_context(**opciones)
        else:
            raise
    pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
    if not visible:
        # En modo oculto el navegador se anuncia como "HeadlessChrome"; lo dejamos como un navegador normal.
        agente = pagina.evaluate("navigator.userAgent").replace("HeadlessChrome", "Chrome")
        contexto.set_extra_http_headers({"User-Agent": agente})
        contexto.add_init_script(
            "Object.defineProperty(navigator, 'userAgent', {get: () => %s});"
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});" % json.dumps(agente))
    return contexto, pagina


def leer_monitor(pagina, monitor: dict, cfg: dict) -> list[dict]:
    from playwright.sync_api import TimeoutError as PWTimeout

    nav = cfg.get("navegador") or {}
    max_paginas = int(monitor.get("max_paginas") or nav.get("max_paginas") or 3)
    pausa = nav.get("pausa_seg") or [3, 7]
    url: str | None = url_de_monitor(monitor)
    productos: dict[str, dict] = {}
    leidas = 0
    while url and leidas < max_paginas:
        pagina.goto(url, wait_until="domcontentloaded", timeout=60_000)
        if es_muro_login(pagina.url):
            raise MuroLogin(url)
        try:
            pagina.wait_for_selector(".poly-card, h1.ui-pdp-title, .ui-search-layout", timeout=20_000)
        except PWTimeout:
            if es_muro_login(pagina.url):
                raise MuroLogin(url)
            log.warning("No encontré productos en %s", url)
            break
        for _ in range(3):  # baja un poco para que carguen las imágenes
            pagina.mouse.wheel(0, 2500)
            pagina.wait_for_timeout(500)
        encontrados = pagina.evaluate(JS_TARJETAS)
        if not encontrados:
            encontrados = pagina.evaluate(JS_PRODUCTO)
        for p in encontrados:
            if p.get("id"):
                p["promos"] = [limpiar_montos(t) for t in p.get("promos") or []]
                p["cupones"] = [limpiar_montos(t) for t in p.get("cupones") or []]
                if p.get("imagen"):  # Telegram no acepta .webp como foto; mlstatic también sirve .jpg
                    p["imagen"] = re.sub(r"\.webp(\?.*)?$", ".jpg", p["imagen"])
                productos.setdefault(p["id"], p)
        leidas += 1
        url = pagina.evaluate(JS_SIGUIENTE)
        if url:
            pagina.wait_for_timeout(int(random.uniform(*pausa) * 1000))
    return list(productos.values())


# --------------------------------------------------------------------------- #
# Cupones y precio final
# --------------------------------------------------------------------------- #


def descuento_de_texto(texto: str, precio: float) -> float:
    """Convierte 'Cupón 10% OFF hasta $300' o '$150 OFF con cupón' en pesos de descuento."""
    t = sin_acentos(texto)
    tope = None
    m = re.search(r"(?:hasta|tope|max(?:imo)?)\D{0,6}\$\s*([\d.,]+)", t)
    if m:
        tope = a_numero(m.group(1))
        t = t[:m.start()] + t[m.end():]
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*%", t)
    if m:
        d = precio * float(m.group(1).replace(",", ".")) / 100
        return round(min(d, tope) if tope else d, 2)
    m = re.search(r"\$\s*([\d.,]+)", t)
    if m:
        return round(min(a_numero(m.group(1)), precio), 2)
    return 0.0


def cupon_aplica(cupon: dict, producto: dict, monitor: dict) -> bool:
    if cupon.get("activo") is False:
        return False
    vence = cupon.get("vence")
    if vence:
        try:
            if date.fromisoformat(vence) < date.today():
                return False
        except ValueError:
            pass
    if producto["precio"] < float(cupon.get("compra_minima") or 0):
        return False
    monitores = cupon.get("monitores") or []
    if monitores and monitor.get("nombre") not in monitores:
        return False
    palabras = cupon.get("palabras") or []
    if palabras:
        titulo = sin_acentos(producto["titulo"])
        if not any(sin_acentos(p) in titulo for p in palabras):
            return False
    return True


def descuento_cupon_manual(cupon: dict, precio: float) -> float:
    if cupon.get("porcentaje"):
        d = precio * float(cupon["porcentaje"]) / 100
    else:
        d = float(cupon.get("monto") or 0)
    tope = cupon.get("tope")
    if tope:
        d = min(d, float(tope))
    return round(min(d, precio), 2)


def calcular_final(producto: dict, monitor: dict, cfg: dict) -> dict:
    """Agrega al producto: descuento_pct, cupones_aplicados y precio_final."""
    precio = producto["precio"]
    anterior = producto.get("precio_anterior")
    m = re.search(r"(\d+)\s*%", producto.get("etiqueta_descuento") or "")
    if m:  # el % que muestra Mercado Libre
        producto["descuento_pct"] = int(m.group(1))
    elif anterior and anterior > precio:
        producto["descuento_pct"] = round((anterior - precio) / anterior * 100)
    else:
        producto["descuento_pct"] = 0

    opciones = []
    for texto in producto.get("cupones") or []:
        d = descuento_de_texto(texto, precio)
        if d > 0:
            opciones.append({"nombre": texto, "descuento": d, "origen": "publicacion"})
    for cupon in cfg.get("cupones") or []:
        if cupon_aplica(cupon, producto, monitor):
            d = descuento_cupon_manual(cupon, precio)
            if d > 0:
                opciones.append({"nombre": cupon.get("nombre") or "Tu cupón", "descuento": d, "origen": "tuyo"})

    if cfg.get("cupones_acumulables"):
        aplicados = opciones
    else:  # Mercado Libre normalmente deja usar un cupón por compra: tomamos el mejor
        aplicados = [max(opciones, key=lambda c: c["descuento"])] if opciones else []
    total = sum(c["descuento"] for c in aplicados)
    producto["cupones_aplicados"] = aplicados
    producto["otros_cupones"] = [c for c in opciones if c not in aplicados]
    producto["precio_final"] = round(max(precio - total, 0), 2)
    return producto


def pasa_palabras(producto: dict, monitor: dict) -> bool:
    titulo = sin_acentos(producto["titulo"])
    incluir = monitor.get("incluir") or []
    if incluir and not any(sin_acentos(p) in titulo for p in incluir):
        return False
    if any(sin_acentos(p) in titulo for p in monitor.get("excluir") or []):
        return False
    return True


def en_rango(producto: dict, monitor: dict) -> bool:
    final = producto["precio_final"]
    if monitor.get("precio_min") and final < float(monitor["precio_min"]):
        return False
    if monitor.get("precio_max") and final > float(monitor["precio_max"]):
        return False
    return True


# --------------------------------------------------------------------------- #
# Reglas de aviso
# --------------------------------------------------------------------------- #


def regla(monitor: dict, cfg: dict, clave: str, defecto):
    if monitor.get(clave) is not None:
        return monitor[clave]
    return (cfg.get("reglas") or {}).get(clave, defecto)


def evaluar(db: sqlite3.Connection, producto: dict, monitor: dict, cfg: dict, monitor_nuevo: bool,
            rango_ok: bool = True) -> list[str]:
    """Guarda el producto en el historial y regresa los motivos para avisar (lista vacía = no avisar)."""
    previo = db.execute("SELECT * FROM productos WHERE id = ?", (producto["id"],)).fetchone()
    final = producto["precio_final"]
    cupones_txt = json.dumps(sorted(producto.get("cupones") or []), ensure_ascii=False)
    bajada_min = float(regla(monitor, cfg, "bajada_min_pct", 5))
    descuento_min = float(regla(monitor, cfg, "descuento_min", 20))
    motivos: list[str] = []

    if previo is None:
        objetivo = monitor.get("precio_max")
        if not monitor_nuevo and (producto["descuento_pct"] >= descuento_min or producto["cupones_aplicados"]
                                  or (objetivo and final <= float(objetivo))):
            motivos.append("🆕 Nuevo en oferta")
        db.execute(
            "INSERT INTO productos(id, monitor, titulo, url, imagen, primera_vez, ultima_vez, ultimo_precio, ultimo_final,"
            " minimo_final, ultimo_aviso_final, ultimo_aviso_fecha, cupones) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (producto["id"], monitor.get("nombre"), producto["titulo"], producto["url"], producto.get("imagen"),
             ahora(), ahora(), producto["precio"], final, final, None, None, cupones_txt))
        db.execute("INSERT INTO historial VALUES(?,?,?,?)", (producto["id"], ahora(), producto["precio"], final))
        producto["minimo_final"] = final
        producto["final_anterior"] = None
    else:
        anterior = previo["ultimo_final"]
        minimo = previo["minimo_final"] if previo["minimo_final"] is not None else anterior
        if anterior and final <= anterior * (1 - bajada_min / 100):
            motivos.append(f"📉 Bajó {round((anterior - final) / anterior * 100)}%")
        cupones_previos = set(json.loads(previo["cupones"] or "[]"))
        nuevos_cupones = [c for c in producto.get("cupones") or [] if c not in cupones_previos]
        if nuevos_cupones and producto["cupones_aplicados"]:
            motivos.append("🎟️ Apareció un cupón")
        if minimo is not None and final < minimo - 0.5 and motivos:
            motivos.append("🏆 Mínimo histórico")
        objetivo = monitor.get("precio_max")
        if objetivo and final <= float(objetivo) and anterior and anterior > float(objetivo):
            motivos.append("🎯 Llegó a tu precio")

        ultimo_aviso = previo["ultimo_aviso_final"]
        if motivos and ultimo_aviso is not None and final >= ultimo_aviso - 0.5 and not nuevos_cupones:
            motivos = []  # ya avisamos a este precio o uno menor
        if ultimo_aviso is not None and final > ultimo_aviso * (1 + bajada_min / 100):
            ultimo_aviso = None  # volvió a subir: si baja otra vez, se avisa de nuevo

        db.execute(
            "UPDATE productos SET titulo=?, url=?, imagen=COALESCE(?, imagen), ultima_vez=?, ultimo_precio=?, ultimo_final=?,"
            " minimo_final=?, ultimo_aviso_final=?, cupones=? WHERE id=?",
            (producto["titulo"], producto["url"], producto.get("imagen"), ahora(), producto["precio"], final,
             min(minimo, final) if minimo is not None else final, ultimo_aviso, cupones_txt, producto["id"]))
        if abs((previo["ultimo_final"] or 0) - final) > 0.009 or abs((previo["ultimo_precio"] or 0) - producto["precio"]) > 0.009:
            db.execute("INSERT INTO historial VALUES(?,?,?,?)", (producto["id"], ahora(), producto["precio"], final))
        producto["minimo_final"] = min(minimo, final) if minimo is not None else final
        producto["final_anterior"] = anterior

    if not rango_ok:
        motivos = []  # se guarda el historial, pero no se avisa fuera del rango de precio
    if motivos:
        db.execute("UPDATE productos SET ultimo_aviso_final=?, ultimo_aviso_fecha=? WHERE id=?",
                   (final, ahora(), producto["id"]))
    return motivos


def formatear_aviso(producto: dict, monitor: dict, motivos: list[str]) -> str:
    lineas = [f"<b>{' · '.join(esc(m) for m in motivos)}</b>  <i>({esc(monitor.get('nombre'))})</i>",
              f"<b>{esc(producto['titulo'])}</b>", ""]
    precio = producto["precio"]
    anterior = producto.get("precio_anterior")
    linea_precio = f"💰 Precio: <b>{pesos(precio)}</b>"
    if anterior and anterior > precio:
        linea_precio = f"💰 Precio: <s>{pesos(anterior)}</s> → <b>{pesos(precio)}</b> ({producto['descuento_pct']}% OFF)"
    lineas.append(linea_precio)
    for c in producto.get("cupones_aplicados") or []:
        quien = "Cupón de la publicación" if c["origen"] == "publicacion" else "Tu cupón"
        lineas.append(f"🎟️ {quien}: {esc(c['nombre'])} → −{pesos(c['descuento'])}")
    for c in producto.get("otros_cupones") or []:
        lineas.append(f"   ↳ otra opción: {esc(c['nombre'])} (−{pesos(c['descuento'])})")
    lineas.append(f"✅ <b>Precio final: {pesos(producto['precio_final'])}</b>")
    extra = []
    if producto.get("final_anterior"):
        extra.append(f"antes {pesos(producto['final_anterior'])}")
    if producto.get("minimo_final") is not None:
        extra.append(f"mínimo visto {pesos(producto['minimo_final'])}")
    if extra:
        lineas.append("📊 " + " · ".join(extra))
    for p in (producto.get("promos") or [])[:3]:
        lineas.append(f"💳 {esc(p)}")
    if producto.get("envio"):
        lineas.append(f"🚚 {esc(producto['envio'])}")
    lineas.append(f'<a href="{html.escape(producto["url"])}">Ver en Mercado Libre</a>')
    return "\n".join(lineas)


def resumen_inicial(monitor: dict, productos: list[dict]) -> str:
    top = sorted(productos, key=lambda p: (-p["descuento_pct"], p["precio_final"]))[:5]
    lineas = [f"✅ <b>Empecé a vigilar: {esc(monitor.get('nombre'))}</b>",
              f"Encontré {len(productos)} productos. Te aviso cuando bajen de precio, salgan nuevas ofertas o aparezca un cupón."]
    if top:
        lineas += ["", "<b>Mejores descuentos ahorita:</b>"]
        for p in top:
            desc = f' ({p["descuento_pct"]}% OFF)' if p["descuento_pct"] else ""
            lineas.append(f'• <a href="{html.escape(p["url"])}">{esc(p["titulo"][:70])}</a> — '
                          f'{pesos(p["precio_final"])}{desc}')
    return "\n".join(lineas)


# --------------------------------------------------------------------------- #
# Comandos de Telegram
# --------------------------------------------------------------------------- #

AYUDA = """<b>Comandos</b>
/lista — qué estoy vigilando
/agregar &lt;tienda, búsqueda o URL&gt; [max=1500] [desc=20]
   ej: <code>/agregar tienda:seiko</code>
   ej: <code>/agregar reloj casio max=1200 desc=25</code>
/quitar &lt;número&gt; — deja de vigilar un monitor
/pausar &lt;número&gt; · /activar &lt;número&gt;
/cupones — tus cupones guardados
/cupon 10% tope=300 min=500 palabras=reloj,casio vence=2026-12-31
/cupon $150 min=999 — cupón de monto fijo
/quitarcupon &lt;número&gt;
/estado — última revisión y totales

Los comandos se procesan cada vez que el bot revisa (o al momento si está en modo continuo)."""


def _opciones(texto: str) -> tuple[str, dict]:
    opciones = dict(re.findall(r"(\w+)=(\S+)", texto))
    resto = re.sub(r"\w+=\S+", "", texto).strip()
    return resto, opciones


def procesar_comando(texto: str, cfg: dict, db: sqlite3.Connection) -> tuple[str, bool]:
    """Regresa (respuesta, config_cambio)."""
    partes = texto.strip().split(maxsplit=1)
    cmd = partes[0].split("@")[0].lower()
    arg = partes[1].strip() if len(partes) > 1 else ""
    monitores = cfg.setdefault("monitores", [])
    cupones = cfg.setdefault("cupones", [])

    def indice(n: str, lista: list) -> int | None:
        return int(n) - 1 if n.isdigit() and 1 <= int(n) <= len(lista) else None

    if cmd in ("/start", "/ayuda", "/help"):
        return AYUDA, False
    if cmd == "/lista":
        if not monitores:
            return "No estoy vigilando nada todavía. Usa /agregar.", False
        filas = []
        for i, m in enumerate(monitores, 1):
            estado = "✅" if m.get("activo", True) else "⏸️"
            extras = []
            if m.get("precio_max"):
                extras.append(f"máx {pesos(float(m['precio_max']))}")
            if m.get("descuento_min") is not None:
                extras.append(f"desc ≥{float(m['descuento_min']):g}%")
            filas.append(f"{i}. {estado} <b>{esc(m.get('nombre'))}</b>"
                         f"{(' — ' + ', '.join(extras)) if extras else ''}\n   {esc(url_de_monitor(m))}")
        return "\n".join(filas), False
    if cmd == "/agregar":
        resto, op = _opciones(arg)
        if not resto:
            return "Dime qué vigilar, ej: <code>/agregar tienda:casio</code> o <code>/agregar reloj casio max=1500</code>", False
        nuevo: dict = {"activo": True}
        if resto.lower().startswith("tienda:"):
            nuevo["tienda"] = resto.split(":", 1)[1].strip()
            nuevo["nombre"] = f"Tienda {nuevo['tienda']}"
        elif resto.startswith("http"):
            nuevo["url"] = resto
            nuevo["nombre"] = re.sub(r"^https?://", "", resto)[:50]
        else:
            nuevo["busqueda"] = resto
            nuevo["nombre"] = resto
        if "max" in op:
            nuevo["precio_max"] = a_numero(op["max"])
        if "desc" in op:
            nuevo["descuento_min"] = a_numero(op["desc"])
        if "nombre" in op:
            nuevo["nombre"] = op["nombre"].replace("_", " ")
        monitores.append(nuevo)
        aviso = ""
        if "tienda" not in nuevo:
            aviso = "\n⚠️ Las búsquedas y categorías solo funcionan si iniciaste sesión (iniciar_sesion.bat)."
        return f"Listo, agregué <b>{esc(nuevo['nombre'])}</b> (#{len(monitores)}).{aviso}", True
    if cmd in ("/quitar", "/pausar", "/activar"):
        i = indice(arg, monitores)
        if i is None:
            return "Número inválido. Revisa /lista.", False
        if cmd == "/quitar":
            m = monitores.pop(i)
            return f"Quité <b>{esc(m.get('nombre'))}</b>.", True
        monitores[i]["activo"] = cmd == "/activar"
        return f"{'Activé' if cmd == '/activar' else 'Pausé'} <b>{esc(monitores[i].get('nombre'))}</b>.", True
    if cmd == "/cupones":
        if not cupones:
            return "No tienes cupones guardados. Agrega uno con /cupon 10% tope=300", False
        filas = []
        for i, c in enumerate(cupones, 1):
            valor = f"{float(c['porcentaje']):g}%" if c.get("porcentaje") else pesos(float(c.get("monto") or 0))
            det = [f"tope {pesos(float(c['tope']))}"] if c.get("tope") else []
            if c.get("compra_minima"):
                det.append(f"mín {pesos(float(c['compra_minima']))}")
            if c.get("palabras"):
                det.append("solo: " + ", ".join(c["palabras"]))
            if c.get("vence"):
                det.append(f"vence {c['vence']}")
            estado = "" if c.get("activo", True) else " (inactivo)"
            filas.append(f"{i}. <b>{esc(c.get('nombre') or valor)}</b> — {valor}{(' · ' + ' · '.join(det)) if det else ''}{estado}")
        return "\n".join(filas), False
    if cmd == "/cupon":
        resto, op = _opciones(arg)
        m_pct = re.search(r"(\d+(?:[.,]\d+)?)\s*%", resto)
        m_monto = re.search(r"\$\s*([\d.,]+)", resto)
        if not (m_pct or m_monto):
            return "Formato: <code>/cupon 10% tope=300 min=500 palabras=reloj vence=2026-12-31</code>", False
        cupon: dict = {"activo": True}
        if m_pct:
            cupon["porcentaje"] = float(m_pct.group(1).replace(",", "."))
        else:
            cupon["monto"] = a_numero(m_monto.group(1))
        if "tope" in op:
            cupon["tope"] = a_numero(op["tope"])
        if "min" in op:
            cupon["compra_minima"] = a_numero(op["min"])
        if "palabras" in op:
            cupon["palabras"] = [p.replace("_", " ") for p in op["palabras"].split(",") if p]
        if "vence" in op:
            try:
                date.fromisoformat(op["vence"])
                cupon["vence"] = op["vence"]
            except ValueError:
                return "La fecha de 'vence' debe ser AAAA-MM-DD, ej: vence=2026-12-31", False
        nombre = op.get("nombre", "").replace("_", " ")
        valor = f"{cupon['porcentaje']:g}%" if "porcentaje" in cupon else pesos(cupon["monto"])
        cupon["nombre"] = nombre or f"Cupón {valor}" + (f" en {', '.join(cupon['palabras'])}" if cupon.get("palabras") else "")
        cupones.append(cupon)
        return f"Guardé <b>{esc(cupon['nombre'])}</b>. Lo voy a usar para calcular el precio final.", True
    if cmd == "/quitarcupon":
        i = indice(arg, cupones)
        if i is None:
            return "Número inválido. Revisa /cupones.", False
        c = cupones.pop(i)
        return f"Quité <b>{esc(c.get('nombre'))}</b>.", True
    if cmd == "/estado":
        total = db.execute("SELECT COUNT(*) FROM productos").fetchone()[0]
        avisos = db.execute("SELECT COUNT(*) FROM productos WHERE ultimo_aviso_fecha IS NOT NULL").fetchone()[0]
        ultima = leer_estado(db, "ultima_revision", "nunca")
        return (f"Última revisión: {esc(ultima)}\nProductos en historial: {total}\n"
                f"Productos con aviso enviado: {avisos}\nMonitores activos: "
                f"{sum(1 for m in monitores if m.get('activo', True))}"), False
    return "No conozco ese comando. Escribe /ayuda.", False


def atender_comandos(tg: Telegram, cfg: dict, db: sqlite3.Connection, espera: int = 0) -> bool:
    """Lee mensajes pendientes del chat y los responde. Regresa True si cambió config.json."""
    if tg.simular or not tg.token:
        return False
    offset = leer_estado(db, "telegram_offset")
    try:
        updates = tg.actualizaciones(int(offset) if offset else None, espera)
    except RuntimeError as e:
        log.warning("No pude leer comandos de Telegram: %s", e)
        return False
    cambio = False
    for u in updates:
        poner_estado(db, "telegram_offset", u["update_id"] + 1)
        msg = u.get("message") or {}
        texto = (msg.get("text") or "").strip()
        chat = str((msg.get("chat") or {}).get("id", ""))
        if not texto.startswith("/"):
            continue
        if chat != tg.chat_id:
            log.info("Ignoré un comando de otro chat (%s).", chat)
            continue
        try:
            respuesta, cambio_cfg = procesar_comando(texto, cfg, db)
        except Exception as e:  # un comando raro no debe tumbar el bot
            log.exception("Error con el comando %s", texto)
            respuesta, cambio_cfg = f"Ese comando falló: {esc(e)}", False
        if cambio_cfg:
            guardar_config(cfg)
            cambio = True
        tg.enviar(respuesta)
    return cambio


# --------------------------------------------------------------------------- #
# Revisión principal
# --------------------------------------------------------------------------- #


def revisar(cfg: dict, db: sqlite3.Connection, tg: Telegram) -> None:
    from playwright.sync_api import sync_playwright

    activos = [m for m in cfg.get("monitores") or [] if m.get("activo", True)]
    if not activos:
        log.info("No hay monitores activos en config.json.")
        return
    max_avisos = int((cfg.get("reglas") or {}).get("max_avisos_por_corrida", 15))
    resumen_al_iniciar = (cfg.get("reglas") or {}).get("resumen_al_iniciar", True)
    pendientes: list[tuple[dict, dict, list[str]]] = []

    with sync_playwright() as pw:
        contexto, pagina = abrir_navegador(pw, cfg)
        try:
            for n, monitor in enumerate(activos):
                nombre = monitor.get("nombre") or url_de_monitor(monitor)
                monitor.setdefault("nombre", nombre)
                clave_init = f"init:{nombre}"
                monitor_nuevo = leer_estado(db, clave_init) is None
                try:
                    productos = leer_monitor(pagina, monitor, cfg)
                except MuroLogin:
                    log.warning("'%s' pide iniciar sesión.", nombre)
                    if not avisado_hace_poco(db, f"aviso_login:{nombre}", 12):
                        tg.enviar(f"🔒 <b>{esc(nombre)}</b>: Mercado Libre pide iniciar sesión para ver esa página.\n"
                                  "Ejecuta <code>iniciar_sesion.bat</code> en tu PC (o usa una tienda oficial: "
                                  "<code>/agregar tienda:casio</code>).")
                        poner_estado(db, f"aviso_login:{nombre}", ahora())
                    continue
                except Exception as e:
                    log.exception("Falló la lectura de '%s'", nombre)
                    if not avisado_hace_poco(db, f"aviso_error:{nombre}", 24):
                        tg.enviar(f"⚠️ No pude revisar <b>{esc(nombre)}</b>: {esc(str(e)[:200])}")
                        poner_estado(db, f"aviso_error:{nombre}", ahora())
                    continue

                validos = []
                for p in productos:
                    calcular_final(p, monitor, cfg)
                    if not pasa_palabras(p, monitor):
                        continue
                    rango_ok = en_rango(p, monitor)
                    motivos = evaluar(db, p, monitor, cfg, monitor_nuevo, rango_ok)
                    if rango_ok:
                        validos.append(p)
                    if motivos:
                        pendientes.append((p, monitor, motivos))
                db.commit()
                log.info("'%s': %d productos leídos, %d pasan filtros.", nombre, len(productos), len(validos))
                if monitor_nuevo and productos:
                    if resumen_al_iniciar:
                        tg.enviar(resumen_inicial(monitor, validos))
                    poner_estado(db, clave_init, ahora())
                if n < len(activos) - 1:
                    pausa = (cfg.get("navegador") or {}).get("pausa_seg") or [3, 7]
                    pagina.wait_for_timeout(int(random.uniform(*pausa) * 1000))
        finally:
            contexto.close()

    pendientes.sort(key=lambda x: (-x[0]["descuento_pct"], x[0]["precio_final"]))
    for producto, monitor, motivos in pendientes[:max_avisos]:
        tg.enviar_foto(producto.get("imagen"), formatear_aviso(producto, monitor, motivos))
    if len(pendientes) > max_avisos:
        resto = pendientes[max_avisos:]
        lineas = [f"…y {len(resto)} ofertas más:"]
        for p, _, motivos in resto[:30]:
            lineas.append(f'• <a href="{html.escape(p["url"])}">{esc(p["titulo"][:60])}</a> — '
                          f'{pesos(p["precio_final"])} ({esc(motivos[0])})')
        tg.enviar("\n".join(lineas))
    poner_estado(db, "ultima_revision", ahora())
    log.info("Revisión terminada: %d avisos.", len(pendientes))


# --------------------------------------------------------------------------- #
# Modos de uso
# --------------------------------------------------------------------------- #


def tomar_candado() -> bool:
    """Evita que dos revisiones corran al mismo tiempo (p. ej. tarea programada + manual)."""
    try:
        if LOCK_PATH.exists() and time.time() - LOCK_PATH.stat().st_mtime < 45 * 60:
            return False
        LOCK_PATH.write_text(str(os.getpid()))
        return True
    except OSError:
        return True


def soltar_candado() -> None:
    try:
        LOCK_PATH.unlink()
    except OSError:
        pass


def crear_telegram(simular: bool) -> Telegram:
    tg = Telegram(os.environ.get("TELEGRAM_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID"), simular)
    if not simular:
        if not tg.token:
            sys.exit("Falta TELEGRAM_TOKEN en .env (créalo con @BotFather, ver README).")
        if not tg.chat_id:
            sys.exit("Falta TELEGRAM_CHAT_ID. Ejecuta vincular_telegram.bat (o python bot.py --vincular).")
    return tg


def modo_una_vez(simular: bool) -> None:
    if not tomar_candado():
        log.info("Ya hay una revisión corriendo; salgo.")
        return
    try:
        cfg = cargar_config()
        tg = crear_telegram(simular)
        db = abrir_db()
        if atender_comandos(tg, cfg, db):
            cfg = cargar_config()
        revisar(cfg, db, tg)
        db.close()
    finally:
        soltar_candado()


def modo_continuo(simular: bool) -> None:
    cfg = cargar_config()
    tg = crear_telegram(simular)
    db = abrir_db()
    intervalo = float((cfg.get("continuo") or {}).get("intervalo_minutos", 120)) * 60
    log.info("Modo continuo: reviso cada %.0f minutos. Cierra esta ventana para detenerlo.", intervalo / 60)
    proxima = 0.0
    while True:
        if atender_comandos(tg, cfg, db, espera=0):
            cfg = cargar_config()
        if time.time() >= proxima:
            if tomar_candado():
                try:
                    revisar(cfg, db, tg)
                except Exception:
                    log.exception("La revisión falló; lo intento en la siguiente vuelta.")
                finally:
                    soltar_candado()
            proxima = time.time() + intervalo * random.uniform(0.9, 1.1)
        # Espera comandos hasta 30 s (long polling) o duerme si es simulación
        if tg.simular:
            time.sleep(max(1, min(30, proxima - time.time())))
        elif atender_comandos(tg, cfg, db, espera=25):
            cfg = cargar_config()


def modo_vincular() -> None:
    tg = Telegram(os.environ.get("TELEGRAM_TOKEN"), None)
    if not tg.token:
        sys.exit("Primero pon TELEGRAM_TOKEN en el archivo .env (ver README).")
    yo = tg._api("getMe")
    print(f"\nAbre Telegram, busca a @{yo['username']} y mándale /start.")
    print("Esperando tu mensaje (2 minutos)...")
    offset = None
    fin = time.time() + 120
    while time.time() < fin:
        for u in tg.actualizaciones(offset, espera=20):
            offset = u["update_id"] + 1
            chat = (u.get("message") or {}).get("chat") or {}
            if chat.get("id"):
                guardar_env("TELEGRAM_CHAT_ID", str(chat["id"]))
                tg.enviar("🤖 ¡Listo! Este chat quedó vinculado. Aquí te llegarán las ofertas.\n\n" + AYUDA,
                          chat_id=str(chat["id"]))
                tg.actualizaciones(offset)  # marca el /start como leído
                db = abrir_db()
                poner_estado(db, "telegram_offset", offset)
                print(f"Vinculado al chat {chat['id']} ({chat.get('first_name') or chat.get('title')}). "
                      "Guardé TELEGRAM_CHAT_ID en .env.")
                return
    sys.exit("No recibí ningún mensaje. Vuelve a intentarlo y manda /start a tu bot.")


def modo_login() -> None:
    from playwright.sync_api import sync_playwright

    cfg = cargar_config()
    with sync_playwright() as pw:
        contexto, pagina = abrir_navegador(pw, cfg, visible=True)
        pagina.goto(SITIO, wait_until="domcontentloaded")
        print("\nSe abrió una ventana del navegador del bot.")
        print("1) Inicia sesión en Mercado Libre en ESA ventana (tú escribes tu correo y contraseña).")
        print("2) Cuando ya veas tu nombre arriba, regresa aquí y presiona Enter.")
        input("\nPresiona Enter cuando termines... ")
        pagina.goto(f"{LISTADO}/reloj", wait_until="domcontentloaded")
        pagina.wait_for_timeout(3000)
        if es_muro_login(pagina.url):
            print("\n❌ Mercado Libre todavía pide iniciar sesión. Intenta otra vez.")
        else:
            print("\n✅ Sesión guardada. Ya puedes vigilar búsquedas y categorías.")
        contexto.close()


def modo_prueba() -> None:
    tg = crear_telegram(False)
    tg.enviar("🤖 Mensaje de prueba del bot de Mercado Libre. ¡Todo bien!")
    print("Mensaje enviado. Revisa tu Telegram.")


def main() -> None:
    preparar_consola()
    configurar_log()
    cargar_env()
    ap = argparse.ArgumentParser(description="Bot de ofertas de Mercado Libre -> Telegram")
    ap.add_argument("--continuo", action="store_true", help="queda corriendo y revisa cada N minutos")
    ap.add_argument("--vincular", action="store_true", help="vincula tu chat de Telegram")
    ap.add_argument("--login", action="store_true", help="abre el navegador para iniciar sesión en Mercado Libre")
    ap.add_argument("--prueba", action="store_true", help="manda un mensaje de prueba")
    ap.add_argument("--simular", action="store_true", help="no manda nada a Telegram, imprime los avisos")
    args = ap.parse_args()
    if args.vincular:
        modo_vincular()
    elif args.login:
        modo_login()
    elif args.prueba:
        modo_prueba()
    elif args.continuo:
        modo_continuo(args.simular)
    else:
        modo_una_vez(args.simular)


if __name__ == "__main__":
    main()
