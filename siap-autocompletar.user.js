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
  const LOTE_DEFAULT = 'S0200426'; // <-- cambia este valor cuando cambie el N° de Lote

  // Estos 3 totales son los mismos que B30 (Total Harina), B31 (Total Aceite) y
  // B32 (Total Materia Prima) de tu Excel. El rendimiento se calcula a partir de
  // ellos exactamente igual que las fórmulas =+B30/B32 y =+B31/B32, así el
  // resultado siempre coincide con Excel al 100%, sin errores de redondeo.
  // Actualiza estos 3 valores cuando cambien los totales del periodo (mensual).
  const TOTAL_HARINA_DEFAULT = 867867;
  const TOTAL_ACEITE_DEFAULT = 96420;
  const TOTAL_MP_DEFAULT = 2236792;

  // ======================================================
  //  MAPA DE CAMPOS
  //  "first" = 1ª tarjeta (Harina, campos con id fijo)
  //  "last"  = 2ª tarjeta en adelante (Aceite, generada dinámicamente,
  //            los id cambian cada vez pero el atributo clone-origin no)
  // ======================================================
  const FIRST_IDS = {
    lote: 'TXT_NUM_LOTE',
    fecha: 'TXT_FEC_PRO',
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
    fecha: 'TXT_FEC_DIN',
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
  function fireChangeEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    // Algunos sitios enganchan sus cascades vía jQuery (.on/.live/.delegate).
    // Si jQuery está presente, disparamos también su propio evento 'change'.
    if (window.jQuery) {
      try { window.jQuery(el).trigger('change').trigger('input'); } catch (e) { /* noop */ }
    }
  }

  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    fireChangeEvents(element);
  }

  function setSelectByText(select, text) {
    const target = Array.from(select.options).find(
      (o) => o.textContent.trim().toUpperCase() === text.trim().toUpperCase()
    );
    if (!target) return false;
    select.value = target.value;
    fireChangeEvents(select);
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

  function calcCantidad(pesoTotal, rendimientoFraccion) {
    const raw = pesoTotal * rendimientoFraccion;
    // Excel redondea el resultado a 2 decimales al mostrarlo en la celda,
    // y recién sobre ESE número redondeado se trunca el entero para el formulario web.
    const roundedTo2 = Math.round(raw * 100) / 100;
    return Math.trunc(roundedTo2);
  }

  // ---------- Persistencia entre recargas ----------
  const STORE_KEYS = { lote: 'siap_lote', peso: 'siap_peso', th: 'siap_total_harina', ta: 'siap_total_aceite', tmp: 'siap_total_mp' };

  function saveState() {
    GM_setValue(STORE_KEYS.lote, document.getElementById('siap-lote').value);
    GM_setValue(STORE_KEYS.peso, document.getElementById('siap-peso').value);
    GM_setValue(STORE_KEYS.th, document.getElementById('siap-total-h').value);
    GM_setValue(STORE_KEYS.ta, document.getElementById('siap-total-a').value);
    GM_setValue(STORE_KEYS.tmp, document.getElementById('siap-total-mp').value);
  }

  function loadState() {
    document.getElementById('siap-lote').value = GM_getValue(STORE_KEYS.lote, LOTE_DEFAULT);
    document.getElementById('siap-peso').value = GM_getValue(STORE_KEYS.peso, '');
    document.getElementById('siap-total-h').value = GM_getValue(STORE_KEYS.th, TOTAL_HARINA_DEFAULT);
    document.getElementById('siap-total-a').value = GM_getValue(STORE_KEYS.ta, TOTAL_ACEITE_DEFAULT);
    document.getElementById('siap-total-mp').value = GM_getValue(STORE_KEYS.tmp, TOTAL_MP_DEFAULT);
  }

  function clearState() {
    GM_setValue(STORE_KEYS.lote, LOTE_DEFAULT);
    GM_setValue(STORE_KEYS.peso, '');
    GM_setValue(STORE_KEYS.th, TOTAL_HARINA_DEFAULT);
    GM_setValue(STORE_KEYS.ta, TOTAL_ACEITE_DEFAULT);
    GM_setValue(STORE_KEYS.tmp, TOTAL_MP_DEFAULT);
    loadState();
    updatePreview();
  }

  // ---------- UI ----------
  GM_addStyle(`
    #siap-panel {
      position: fixed; bottom: 20px; left: 20px; width: 270px;
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
    .siap-total-amounts { color: #00fff; }
    #siap-btn-harina { background: #e0a800; }
    #siap-btn-aceite { background: #17a2b8; }
    #siap-btn-clear { background: #aaa; font-weight: normal; font-size: 11px; padding: 5px; }
    #siap-msg { margin-top:6px; font-size:12px; min-height:14px; }
    #siap-fecha-note { margin-top:8px; font-size:11px; color:#b02a00; }
    .siap-highlight { outline: 3px solid #ff4d4f !important; animation: siap-pulse 1s ease-out 4; }
    @keyframes siap-pulse {
      0% { box-shadow: 0 0 0 0 rgba(255,77,79,.7); }
      70% { box-shadow: 0 0 0 9px rgba(255,77,79,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,77,79,0); }
    }
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

    <label>Peso Total</label>
    <input id="siap-peso" type="text" placeholder="Ej. 1090,32">

    <div class="rend-row">
      <div class="siap-total-amounts">
        <label>Total Harina</label>
        <input id="siap-total-h" type="text">
      </div>
      <div class="siap-total-amounts">
        <label>Total Aceite</label>
        <input id="siap-total-a" type="text">
      </div>
    </div>
    <label>Total Materia Prima</label>
    <input id="siap-total-mp" type="text">

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
    const th = parseFloat(document.getElementById('siap-total-h').value);
    const ta = parseFloat(document.getElementById('siap-total-a').value);
    const tmp = parseFloat(document.getElementById('siap-total-mp').value);
    const prevH = document.getElementById('siap-prev-h');
    const prevA = document.getElementById('siap-prev-a');
    if (!isNaN(peso) && !isNaN(th) && !isNaN(ta) && !isNaN(tmp) && tmp !== 0) {
      prevH.textContent = calcCantidad(peso, th / tmp);
      prevA.textContent = calcCantidad(peso, ta / tmp);
    } else {
      prevH.textContent = '-';
      prevA.textContent = '-';
    }
  }

  ['siap-peso', 'siap-total-h', 'siap-total-a', 'siap-total-mp', 'siap-lote'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      updatePreview();
      saveState();
    });
  });

  document.getElementById('siap-btn-clear').addEventListener('click', clearState);

  let currentMsgs = [];
  function resetMsgs() {
    currentMsgs = [];
    renderMsgs();
  }
  function renderMsgs() {
    const el = document.getElementById('siap-msg');
    el.innerHTML = currentMsgs
      .map((m) => `<div style="color:${m.ok ? '#198754' : '#b02a00'}">${m.text}</div>`)
      .join('');
  }
  function showMsg(text, ok) {
    currentMsgs.push({ text, ok });
    renderMsgs();
  }

  function highlightField(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('siap-highlight');
    void el.offsetWidth; // reinicia la animación si ya se había aplicado antes
    el.classList.add('siap-highlight');
    setTimeout(() => el.classList.remove('siap-highlight'), 4000);
  }

  async function fillCommonFields(which, nombreProd) {
    const lote = document.getElementById('siap-lote').value.trim();
    const loteInput = getField('lote', which);
    if (lote && loteInput) setNativeValue(loteInput, lote);

    try {
      await waitForOptionText('estado', which, 'HARINAS, BALANCEADOS Y RESIDUOS', 4000);
    } catch (e) {
      showMsg('⚠ No se pudo seleccionar "Categoría/Estado" a tiempo, hazlo a mano.', false);
    }

    try {
      await waitForOptionText('producto', which, nombreProd, 5000);
    } catch (e) {
      showMsg(`⚠ No cargó "Producto" a tiempo: selecciona a mano "${nombreProd}".`, false);
    }

    try {
      await waitForOptionText('presenta', which, 'Al Granel', 5000);
    } catch (e) {
      showMsg('⚠ No cargó "Presentación" a tiempo: selecciónala a mano (Al Granel).', false);
    }

    const pesoN = getField('pesoNeto', which);
    const pesoC = getField('pesoCarne', which);
    if (pesoN) setNativeValue(pesoN, '1000');
    if (pesoC) setNativeValue(pesoC, '1000');
  }

  async function fillProducto(tipo) {
    resetMsgs();
    const peso = parsePeso(document.getElementById('siap-peso').value);
    const th = parseFloat(document.getElementById('siap-total-h').value);
    const ta = parseFloat(document.getElementById('siap-total-a').value);
    const tmp = parseFloat(document.getElementById('siap-total-mp').value);

    if (isNaN(peso)) return showMsg('Ingresa el Peso Total primero.', false);
    if (isNaN(th) || isNaN(ta) || isNaN(tmp) || tmp === 0) {
      return showMsg('Revisa los 3 totales (Harina/Aceite/Materia Prima).', false);
    }

    const which = tipo === 'harina' ? 'first' : 'last';

    if (tipo === 'aceite' && !secondCardExists()) {
      return showMsg('Aún no existe la 2ª tarjeta. Haz clic primero en "Agregar Nuevo Producto" en la página.', false);
    }

    let cantidad, nombreProd, descripcion;
    if (tipo === 'harina') {
      cantidad = calcCantidad(peso, th / tmp);
      nombreProd = 'Harina de Pescado';
      descripcion = 'PROCESAMIENTO DE HARINA DE PESCADO';
    } else {
      cantidad = calcCantidad(peso, ta / tmp);
      nombreProd = 'Aceite de Pescado';
      descripcion = 'PROCESAMIENTO DE ACEITE DE PESCADO';
    }

    await fillCommonFields(which, nombreProd);

    const descField = getField('descripcion', which);
    const cantField = getField('cantidad', which);
    if (descField) setNativeValue(descField, descripcion);
    if (cantField) setNativeValue(cantField, String(cantidad));

    highlightField(getField('fecha', which));

    saveState();
    showMsg(`✅ Listo: ${nombreProd} (${which === 'first' ? '1ª' : '2ª'} tarjeta) → Cantidad Producida = ${cantidad}. Falta la fecha (resaltada) y revisar antes de enviar.`, true);
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
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  })();

  loadState();
  updatePreview();
  } // fin init()

  init();
})();