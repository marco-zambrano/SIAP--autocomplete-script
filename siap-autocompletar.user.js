// ==UserScript==
// @name         SIAP - Autocompletar Harina/Aceite de Pescado
// @namespace    siap-autofill
// @version      3.0
// @description  Autocompleta campos repetitivos del formulario de producción (Harina/Aceite de Pescado) a partir del Peso Total. Nunca envía el formulario automáticamente: eso siempre lo hace la persona.
// @match        https://siap.aciis.services/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // El formulario puede vivir dentro de un <iframe>. Este script se inyecta en
  // TODOS los frames de siap.aciis.services, así que primero verifica que este
  // frame en particular realmente tenga el campo del formulario antes de armar
  // el panel. Si no lo tiene (ej. la página contenedora), no hace nada.
  function waitForFormReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (document.getElementById('TXT_NUM_LOTE')) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('form not in this frame'));
        requestAnimationFrame(check);
      })();
    });
  }

  // ======================================================
  //  CONFIGURACIÓN - EDITA AQUÍ LOS VALORES QUE CAMBIAN POCO
  // ======================================================
  const LOTE_DEFAULT = 'S0100726';   // <-- cambia este valor cuando cambie el N° de Lote
  const DEFAULT_REND_HARINA = 38.80; // % - rendimiento de harina (celda B33 del Excel)
  const DEFAULT_REND_ACEITE = 4.31;  // % - rendimiento de aceite (celda B34 del Excel)

  // ======================================================
  //  MAPA DE CAMPOS
  //  "first" = 1ª tarjeta (Harina, campos con id fijo)
  //  "last"  = 2ª tarjeta en adelante (Aceite, generada dinámicamente,
  //            los id cambian cada vez pero el atributo clone-origin no)
  // ======================================================
  const FIRST_IDS = {
    lote: 'TXT_NUM_LOTE',
    estado: 'CMB_ESTADO',
    producto: 'CMB_PROD',
    presenta: 'TXT_PRESENTA',
    pesoNeto: 'TXT_PESO_N',
    pesoCarne: 'TXT_PESO_C',
    cantidad: 'TXT_CANT_PRO',
    descripcion: 'TXT_DESCR',
  };

  const CLONE_ORIGINS = {
    lote: 'TXT_DIN_LOTE',
    estado: 'CMB_DYNAMIC',
    producto: 'CMB_DIN_PROD',
    presenta: 'CMB_DIN_PRES',
    pesoNeto: 'TXT_DIN_PNET',
    pesoCarne: 'TXT_DIN_CARN',
    cantidad: 'TXT_DIN_CNTP',
    descripcion: 'TXT_DIN_DESC',
  };

  function getField(key, which) {
    if (which === 'first') {
      const id = FIRST_IDS[key];
      return id ? document.getElementById(id) : null;
    }
    const cloneOrigin = CLONE_ORIGINS[key];
    if (!cloneOrigin) return null;
    const els = document.querySelectorAll(`[clone-origin="${cloneOrigin}"]`);
    return els.length ? els[els.length - 1] : null;
  }

  function secondCardExists() {
    return !!document.querySelector(`[clone-origin="${CLONE_ORIGINS.lote}"]`);
  }

  // ---------- Helpers para setear valores respetando frameworks basados en eventos ----------
  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('keyup', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setSelectByText(select, text) {
    const target = Array.from(select.options).find(
      (o) => o.textContent.trim().toUpperCase() === text.trim().toUpperCase()
    );
    if (!target) return false;
    select.value = target.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Espera a que la opción con el texto dado exista en el select (re-consulta el
  // campo en cada intento, por si el sitio reemplaza/repuebla el nodo tras un cascade).
  function waitForOptionText(key, which, text, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        const el = getField(key, which);
        if (el && el.options) {
          const has = Array.from(el.options).some(
            (o) => o.textContent.trim().toUpperCase() === text.trim().toUpperCase()
          );
          if (has) {
            setSelectByText(el, text);
            return resolve(el);
          }
        }
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout: ' + key));
        requestAnimationFrame(check);
      })();
    });
  }

  function parsePeso(str) {
    if (!str) return NaN;
    return parseFloat(str.toString().trim().replace(',', '.'));
  }

  function calcCantidad(pesoTotal, rendimientoPercent) {
    return Math.trunc(pesoTotal * (rendimientoPercent / 100));
  }

  // ---------- Persistencia entre recargas ----------
  const STORE_KEYS = { lote: 'siap_lote', peso: 'siap_peso', rh: 'siap_rend_harina', ra: 'siap_rend_aceite' };

  function saveState() {
    GM_setValue(STORE_KEYS.lote, document.getElementById('siap-lote').value);
    GM_setValue(STORE_KEYS.peso, document.getElementById('siap-peso').value);
    GM_setValue(STORE_KEYS.rh, document.getElementById('siap-rend-h').value);
    GM_setValue(STORE_KEYS.ra, document.getElementById('siap-rend-a').value);
  }

  function loadState() {
    document.getElementById('siap-lote').value = GM_getValue(STORE_KEYS.lote, LOTE_DEFAULT);
    document.getElementById('siap-peso').value = GM_getValue(STORE_KEYS.peso, '');
    document.getElementById('siap-rend-h').value = GM_getValue(STORE_KEYS.rh, DEFAULT_REND_HARINA);
    document.getElementById('siap-rend-a').value = GM_getValue(STORE_KEYS.ra, DEFAULT_REND_ACEITE);
  }

  function clearState() {
    GM_setValue(STORE_KEYS.lote, LOTE_DEFAULT);
    GM_setValue(STORE_KEYS.peso, '');
    GM_setValue(STORE_KEYS.rh, DEFAULT_REND_HARINA);
    GM_setValue(STORE_KEYS.ra, DEFAULT_REND_ACEITE);
    loadState();
    updatePreview();
  }

  // ---------- UI ----------
  GM_addStyle(`
    #siap-panel {
      position: fixed; top: 80px; right: 20px; width: 270px;
      background: #fff; border: 2px solid #17a2b8; border-radius: 10px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); font-family: Arial, sans-serif;
      font-size: 13px; z-index: 999999; padding: 12px; color: #222;
    }
    #siap-panel h3 { margin: 0 0 8px 0; font-size: 14px; color: #17a2b8; cursor: move; }
    #siap-panel label { display:block; margin-top:8px; font-weight:bold; }
    #siap-panel input { width: 100%; box-sizing: border-box; padding: 4px; margin-top:2px; }
    #siap-panel .rend-row { display:flex; gap:6px; }
    #siap-panel .rend-row > div { flex:1; }
    #siap-preview { margin-top:10px; background:#f1f9fb; border:1px solid #cdeef3; border-radius:6px; padding:6px; }
    #siap-preview b { color:#0d6efd; }
    #siap-panel button {
      width: 100%; margin-top: 8px; padding: 7px; border: none; border-radius: 6px;
      color: #fff; font-weight: bold; cursor: pointer;
    }
    #siap-btn-harina { background: #e0a800; }
    #siap-btn-aceite { background: #17a2b8; }
    #siap-btn-clear { background: #aaa; font-weight: normal; font-size: 11px; padding: 5px; }
    #siap-msg { margin-top:6px; font-size:12px; min-height:14px; }
    #siap-fecha-note { margin-top:8px; font-size:11px; color:#b02a00; }
  `);

  async function init() {
  try {
    await waitForFormReady(8000);
  } catch (e) {
    return; // Este frame no tiene el formulario: no se crea ningún panel aquí.
  }

  const panel = document.createElement('div');
  panel.id = 'siap-panel';
  panel.innerHTML = `
    <h3>🐟 Autocompletar SIAP</h3>
    <label>N° Lote Procesado</label>
    <input id="siap-lote" type="text" placeholder="Ej. S0100726">

    <label>Peso Total (E31)</label>
    <input id="siap-peso" type="text" placeholder="Ej. 1090,32">

    <div class="rend-row">
      <div>
        <label>% Rend. Harina</label>
        <input id="siap-rend-h" type="text">
      </div>
      <div>
        <label>% Rend. Aceite</label>
        <input id="siap-rend-a" type="text">
      </div>
    </div>

    <div id="siap-preview">Cantidad Harina: <b id="siap-prev-h">-</b><br>Cantidad Aceite: <b id="siap-prev-a">-</b></div>

    <div id="siap-fecha-note">⚠️ Recuerda seleccionar tú mismo la fecha en el calendario (misma fecha para ambos productos).</div>

    <button id="siap-btn-harina">1️⃣ Rellenar HARINA (1ª tarjeta)</button>
    <button id="siap-btn-aceite">2️⃣ Rellenar ACEITE (2ª tarjeta)</button>
    <button id="siap-btn-clear">Restablecer valores por defecto</button>
    <div id="siap-msg"></div>
  `;
  document.body.appendChild(panel);

  function updatePreview() {
    const peso = parsePeso(document.getElementById('siap-peso').value);
    const rh = parseFloat(document.getElementById('siap-rend-h').value);
    const ra = parseFloat(document.getElementById('siap-rend-a').value);
    const prevH = document.getElementById('siap-prev-h');
    const prevA = document.getElementById('siap-prev-a');
    if (!isNaN(peso) && !isNaN(rh) && !isNaN(ra)) {
      prevH.textContent = calcCantidad(peso, rh);
      prevA.textContent = calcCantidad(peso, ra);
    } else {
      prevH.textContent = '-';
      prevA.textContent = '-';
    }
  }

  ['siap-peso', 'siap-rend-h', 'siap-rend-a', 'siap-lote'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      updatePreview();
      saveState();
    });
  });

  document.getElementById('siap-btn-clear').addEventListener('click', clearState);

  function showMsg(text, ok) {
    const el = document.getElementById('siap-msg');
    el.textContent = text;
    el.style.color = ok ? '#198754' : '#b02a00';
  }

  async function fillCommonFields(which) {
    const lote = document.getElementById('siap-lote').value.trim();
    const loteInput = getField('lote', which);
    if (lote && loteInput) setNativeValue(loteInput, lote);

    try {
      await waitForOptionText('estado', which, 'HARINAS, BALANCEADOS Y RESIDUOS', 4000);
    } catch (e) {
      showMsg('No se pudo seleccionar "Categoría/Estado" a tiempo, hazlo a mano.', false);
    }

    try {
      await waitForOptionText('presenta', which, 'Al Granel', 5000);
    } catch (e) {
      showMsg('No cargó "Presentación" a tiempo: selecciónala a mano (Al Granel).', false);
    }

    const pesoN = getField('pesoNeto', which);
    const pesoC = getField('pesoCarne', which);
    if (pesoN) setNativeValue(pesoN, '1000');
    if (pesoC) setNativeValue(pesoC, '1000');
  }

  async function fillProducto(tipo) {
    const peso = parsePeso(document.getElementById('siap-peso').value);
    const rh = parseFloat(document.getElementById('siap-rend-h').value);
    const ra = parseFloat(document.getElementById('siap-rend-a').value);

    if (isNaN(peso)) return showMsg('Ingresa el Peso Total primero.', false);

    const which = tipo === 'harina' ? 'first' : 'last';

    if (tipo === 'aceite' && !secondCardExists()) {
      return showMsg('Aún no existe la 2ª tarjeta. Haz clic primero en "Agregar Nuevo Producto" en la página.', false);
    }

    await fillCommonFields(which);

    let cantidad, nombreProd, descripcion;
    if (tipo === 'harina') {
      cantidad = calcCantidad(peso, rh);
      nombreProd = 'Harina de Pescado';
      descripcion = 'PROCESAMIENTO DE HARINA DE PESCADO';
    } else {
      cantidad = calcCantidad(peso, ra);
      nombreProd = 'Aceite de Pescado';
      descripcion = 'PROCESAMIENTO DE ACEITE DE PESCADO';
    }

    try {
      await waitForOptionText('producto', which, nombreProd, 5000);
    } catch (e) {
      showMsg(`No cargó "Producto" a tiempo: selecciona a mano "${nombreProd}".`, false);
    }

    const descField = getField('descripcion', which);
    const cantField = getField('cantidad', which);
    if (descField) setNativeValue(descField, descripcion);
    if (cantField) setNativeValue(cantField, String(cantidad));

    saveState();
    showMsg(`Listo: ${nombreProd} (${which === 'first' ? '1ª' : '2ª'} tarjeta) → Cantidad Producida = ${cantidad}. Revisa y envía tú mismo.`, true);
  }

  document.getElementById('siap-btn-harina').addEventListener('click', () => fillProducto('harina'));
  document.getElementById('siap-btn-aceite').addEventListener('click', () => fillProducto('aceite'));

  // Panel arrastrable
  (function makeDraggable() {
    const header = panel.querySelector('h3');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      offX = e.clientX - panel.offsetLeft;
      offY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - offX) + 'px';
      panel.style.top = (e.clientY - offY) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  })();

  loadState();
  updatePreview();
  } // fin init()

  init();
})();