// ==UserScript==
// @name         SIAP - Autocompletar Harina/Aceite de Pescado
// @namespace    siap-autofill
// @version      1.0
// @description  Autocompleta campos repetitivos del formulario de producción (Harina/Aceite de Pescado) a partir del Peso Total. Nunca envía el formulario automáticamente: eso siempre lo hace la persona.
// @match        https://siap.aciis.services/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Config (rendimientos por defecto, editables en el panel) ----------
  const DEFAULT_REND_HARINA = 38.80; // %
  const DEFAULT_REND_ACEITE = 4.31;  // %

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

  function waitForOptions(select, minCount, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (select.options.length >= minCount) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
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

  // ---------- Persistencia entre recargas (Harina -> Agregar Nuevo Producto -> Aceite) ----------
  const STORE_KEYS = { lote: 'siap_lote', peso: 'siap_peso', rh: 'siap_rend_harina', ra: 'siap_rend_aceite' };

  function saveState() {
    GM_setValue(STORE_KEYS.lote, document.getElementById('siap-lote').value);
    GM_setValue(STORE_KEYS.peso, document.getElementById('siap-peso').value);
    GM_setValue(STORE_KEYS.rh, document.getElementById('siap-rend-h').value);
    GM_setValue(STORE_KEYS.ra, document.getElementById('siap-rend-a').value);
  }

  function loadState() {
    document.getElementById('siap-lote').value = GM_getValue(STORE_KEYS.lote, '');
    document.getElementById('siap-peso').value = GM_getValue(STORE_KEYS.peso, '');
    document.getElementById('siap-rend-h').value = GM_getValue(STORE_KEYS.rh, DEFAULT_REND_HARINA);
    document.getElementById('siap-rend-a').value = GM_getValue(STORE_KEYS.ra, DEFAULT_REND_ACEITE);
  }

  function clearState() {
    GM_setValue(STORE_KEYS.lote, '');
    GM_setValue(STORE_KEYS.peso, '');
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

  const panel = document.createElement('div');
  panel.id = 'siap-panel';
  panel.innerHTML = `
    <h3>🐟 Autocompletar SIAP</h3>
    <label>N° Lote Procesado</label>
    <input id="siap-lote" type="text" placeholder="Ej. S0300726">

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

    <button id="siap-btn-harina">1️⃣ Rellenar HARINA</button>
    <button id="siap-btn-aceite">2️⃣ Rellenar ACEITE</button>
    <button id="siap-btn-clear">Borrar lote/peso guardados</button>
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

  async function fillCommonFields() {
    const lote = document.getElementById('siap-lote').value.trim();
    const loteInput = document.getElementById('TXT_NUM_LOTE');
    if (lote && loteInput) setNativeValue(loteInput, lote);

    const estadoSelect = document.getElementById('CMB_ESTADO');
    if (estadoSelect) setSelectByText(estadoSelect, 'HARINAS, BALANCEADOS Y RESIDUOS');

    const presentaSelect = document.getElementById('TXT_PRESENTA');
    if (presentaSelect) {
      try {
        await waitForOptions(presentaSelect, 2, 4000);
        setSelectByText(presentaSelect, 'Al Granel');
      } catch (e) {
        showMsg('No cargó "Presentación" a tiempo: selecciónala a mano (Al Granel).', false);
      }
    }

    const pesoN = document.getElementById('TXT_PESO_N');
    const pesoC = document.getElementById('TXT_PESO_C');
    if (pesoN) setNativeValue(pesoN, '1000');
    if (pesoC) setNativeValue(pesoC, '1000');
  }

  async function fillProducto(tipo) {
    const peso = parsePeso(document.getElementById('siap-peso').value);
    const rh = parseFloat(document.getElementById('siap-rend-h').value);
    const ra = parseFloat(document.getElementById('siap-rend-a').value);

    if (isNaN(peso)) return showMsg('Ingresa el Peso Total primero.', false);

    await fillCommonFields();

    const prodSelect = document.getElementById('CMB_PROD');
    const descTextarea = document.getElementById('TXT_DESCR');
    const cantInput = document.getElementById('TXT_CANT_PRO');

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

    if (prodSelect) setSelectByText(prodSelect, nombreProd);
    if (descTextarea) setNativeValue(descTextarea, descripcion);
    if (cantInput) setNativeValue(cantInput, String(cantidad));

    saveState();
    showMsg(`Listo: ${nombreProd} → Cantidad Producida = ${cantidad}. Revisa y envía tú mismo.`, true);
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
})();
