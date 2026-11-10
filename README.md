# Bot de ofertas de Mercado Libre → Telegram

Revisa Mercado Libre México cada cierto tiempo, guarda el historial de precios y te manda un mensaje por Telegram cuando:

- 📉 un producto **baja de precio** (5% o más, configurable)
- 🆕 aparece un **producto nuevo con descuento** (20% o más, configurable)
- 🎟️ aparece un **cupón** en la publicación
- 🎯 un producto **llega al precio máximo** que pusiste
- 🏆 el precio es el **más bajo que ha visto**

Cada aviso trae foto, precio anterior → precio actual, el % de descuento, el cupón aplicado y el **precio final**. También incluye los meses sin intereses y el envío.

## Lo que hay que saber de Mercado Libre (noviembre 2026)

| Página | ¿Se puede leer sin cuenta? |
|---|---|
| Tiendas oficiales (`mercadolibre.com.mx/tienda/casio`) | ✅ Sí (los ~20–60 productos que la tienda destaca) |
| Búsquedas (`listado.mercadolibre.com.mx/reloj-casio`) | ❌ Pide iniciar sesión |
| Categorías y "Todos los productos" de una tienda | ❌ Pide iniciar sesión |
| Página de un producto, sección Ofertas | ❌ Pide iniciar sesión |
| API oficial | ❌ Responde 403 sin token de vendedor |

Por eso el bot tiene dos modos:

1. **Sin cuenta:** vigila tiendas oficiales de marcas (Casio, Seiko, Samsung, Xiaomi, etc.). Funciona en tu PC o gratis en GitHub Actions.
2. **Con tu cuenta:** inicias sesión una vez en la ventana del bot y ya puede vigilar búsquedas, categorías y productos sueltos. Solo funciona en tu PC.
   - ⚠️ Mercado Libre no permite la automatización en sus términos. Úsalo para ti y con revisiones espaciadas (cada 1–3 horas), o te pueden pedir verificaciones o bloquear la cuenta.

## Instalación en Windows (una sola vez)

### 1. Crea tu bot de Telegram
1. En Telegram busca **@BotFather** y mándale `/newbot`.
2. Ponle un nombre y un usuario que termine en `bot` (ej. `ofertas_pablo_bot`).
3. Te va a dar un **token** como `123456789:AAH...`. Guárdalo y no lo compartas.

### 2. Instala Python
Descárgalo de https://www.python.org/downloads/. En el instalador **marca "Add python.exe to PATH"**.

### 3. Instala el bot
1. Doble clic en **`instalar.bat`**.
2. Abre el archivo **`.env`** con el Bloc de notas y pega tu token:
   ```
   TELEGRAM_TOKEN=123456789:AAH...
   ```
3. Doble clic en **`vincular_telegram.bat`** y mándale `/start` a tu bot en Telegram. Te va a contestar que quedó vinculado.

### 4. Pruébalo
- **`probar.bat`**: hace una revisión e imprime los avisos en la ventana, sin mandarlos.
- **`ejecutar.bat`**: hace una revisión de verdad. La primera vez te manda un resumen de lo que empezó a vigilar.
- La primera revisión solo guarda los precios actuales. Los avisos de bajadas llegan en las siguientes.

### 5. Déjalo corriendo solo
Elige una de estas dos formas:

- **`programar_tarea.bat`**: crea una tarea de Windows que revisa cada N horas mientras tu PC esté encendida. No deja ninguna ventana abierta. Para quitarla usa `quitar_tarea.bat`.
- **`modo_continuo.bat`**: deja una ventana abierta que revisa cada 2 horas y **responde los comandos de Telegram al momento**.

### (Opcional) Vigilar búsquedas y categorías
1. Doble clic en **`iniciar_sesion.bat`**. Se abre la ventana del navegador del bot.
2. Inicia sesión en Mercado Libre ahí, tú mismo.
3. Regresa a la ventana negra y presiona Enter.

La sesión queda guardada en la carpeta `perfil_navegador`. No la compartas ni la subas a GitHub.

## Qué vigilar: `config.json`

```json
{
  "monitores": [
    { "nombre": "Relojes Casio", "tienda": "casio", "incluir": ["reloj"], "descuento_min": 20 },
    { "nombre": "G-Shock barato", "busqueda": "casio g-shock", "precio_max": 1800, "excluir": ["correa"] },
    { "nombre": "Una categoría", "url": "https://listado.mercadolibre.com.mx/joyas-relojes/relojes/" }
  ]
}
```

Opciones de cada monitor:

| Campo | Para qué sirve |
|---|---|
| `tienda` | Nombre de la tienda oficial, como aparece en `mercadolibre.com.mx/tienda/<nombre>` |
| `busqueda` | Texto a buscar (requiere sesión) |
| `url` | Cualquier URL de listado, categoría, tienda o producto |
| `incluir` / `excluir` | Palabras que debe tener o no tener el título |
| `descuento_min` | % mínimo para avisar de productos nuevos (default 20) |
| `precio_max` / `precio_min` | Solo avisa si el **precio final** está en ese rango |
| `bajada_min_pct` | Cuánto tiene que bajar para avisar (default 5%) |
| `max_paginas` | Páginas a revisar en búsquedas (default 3) |
| `activo` | `false` para pausarlo |

Para encontrar el nombre de una tienda oficial, entra a la tienda en Mercado Libre y copia lo que va después de `/tienda/` en la dirección.

### Cupones y precio final
- **Cupones de la publicación** (el "Cupón 10% OFF" que se ve en el listado): el bot los detecta y los descuenta solo.
- **Tus cupones** (los de "Mis cupones" en tu cuenta): son distintos para cada persona, así que tú se los dices al bot. Puede ser en `config.json` → `cupones` o con el comando `/cupon` en Telegram. Ejemplo:
  ```json
  { "nombre": "10% en relojes", "porcentaje": 10, "tope": 300, "compra_minima": 500, "palabras": ["reloj"], "vence": "2026-12-31" }
  ```
  Usa `"monto": 150` en lugar de `porcentaje` si es un descuento fijo.
- Mercado Libre normalmente permite **un cupón por compra**, así que el bot usa el que más te ahorra. Si sabes que se pueden juntar, pon `"cupones_acumulables": true`.
- Las promociones bancarias y los meses sin intereses se muestran en el aviso como información, pero no se restan, porque dependen de tu tarjeta.

## Comandos de Telegram

| Comando | Qué hace |
|---|---|
| `/lista` | Muestra qué está vigilando |
| `/agregar tienda:seiko` | Vigila una tienda oficial |
| `/agregar reloj casio max=1500 desc=25` | Vigila una búsqueda (requiere sesión) |
| `/quitar 2` · `/pausar 2` · `/activar 2` | Quita, pausa o activa un monitor |
| `/cupon 10% tope=300 min=500 palabras=reloj vence=2026-12-31` | Guarda uno de tus cupones |
| `/cupon $150 min=999` | Guarda un cupón de monto fijo |
| `/cupones` · `/quitarcupon 1` | Lista o borra tus cupones |
| `/estado` | Muestra la última revisión y los totales |

Con la tarea programada, los comandos se atienden en la siguiente revisión. En modo continuo se atienden al momento.

## Opción gratis en la nube: GitHub Actions (solo tiendas oficiales)

1. Sube esta carpeta a un repo **público** de GitHub, **sin** `.env` ni `perfil_navegador` (el `.gitignore` ya los excluye). Mueve `github_workflow_bot.yml` a `.github/workflows/bot.yml` dentro del repo. En la web de GitHub: *Add file → Create new file*, escribe `.github/workflows/bot.yml` como nombre y pega el contenido.
2. En el repo ve a **Settings → Secrets and variables → Actions** y crea dos secrets:
   - `TELEGRAM_TOKEN`
   - `TELEGRAM_CHAT_ID` (cópialo de tu `.env` después de vincular)
3. En la pestaña **Actions**, activa los workflows y corre "Bot Mercado Libre" con **Run workflow** para probar.
4. Después corre solo cada 2 horas y guarda el historial (`datos.db`) en el mismo repo.

Ten en cuenta:
- En GitHub no hay sesión iniciada, así que solo funcionan las **tiendas oficiales**.
- Mercado Libre puede bloquear las IPs de GitHub. Si empiezan a llegar errores, usa la PC.

## Problemas comunes

- **"No encontré productos" o llegan errores:** Mercado Libre pudo cambiar su página o bloquear temporalmente. Revisa `bot.log` y espera unas horas.
- **🔒 "pide iniciar sesión":** ese monitor es una búsqueda o categoría. Ejecuta `iniciar_sesion.bat` o cámbialo por una tienda oficial.
- **No abre el navegador:** el bot usa Microsoft Edge. Si no lo tienes, en `config.json` pon `"canal": "chromium"` y ejecuta `.venv\Scripts\python -m playwright install chromium`.
- **Quiero empezar de cero:** borra `datos.db` (el historial). La siguiente revisión vuelve a mandar el resumen inicial.

## Archivos

| Archivo | Qué es |
|---|---|
| `bot.py` | El bot |
| `config.json` | Qué vigilar, reglas y cupones |
| `.env` | Token de Telegram (privado) |
| `datos.db` | Historial de precios (SQLite, se crea solo) |
| `bot.log` | Registro de lo que hizo |
| `perfil_navegador/` | Sesión del navegador del bot (privado) |
#   b o t m e r c a d o  
 