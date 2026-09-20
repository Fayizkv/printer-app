import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PAPER_PRESETS,
  canvasToPreviewUrl,
  ditherCanvas,
  dotsFromMm,
  drawImageToCanvas,
  loadImageElement,
  loadPrinterSize,
  mmFromDots,
  normalizeDots,
  printCanvas,
  renderTextCanvas,
  savePrinterSize,
} from './escpos';

const PRINTER_PROFILES = [
  {
    name: 'Generic FFE0 / FFE1',
    serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
    characteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
  },
  {
    name: 'Phomemo / Marklife FF00 / FF02',
    serviceUuid: '0000ff00-0000-1000-8000-00805f9b34fb',
    characteristicUuid: '0000ff02-0000-1000-8000-00805f9b34fb',
  },
  {
    name: 'ISS CAFE / 8841',
    serviceUuid: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    characteristicUuid: '49535343-8841-43f4-a8d4-ecbe34729bb3',
  },
  {
    name: 'E781 / BEF8',
    serviceUuid: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    characteristicUuid: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
];

const DEFAULT_SERVICE_UUID = PRINTER_PROFILES[0].serviceUuid;
const DEFAULT_CHARACTERISTIC_UUID = PRINTER_PROFILES[0].characteristicUuid;

export default function App() {
  const [mode, setMode] = useState('text');
  const [text, setText] = useState('');
  const [status, setStatus] = useState('Paste text or add a photo, then print.');
  const [printerSize, setPrinterSize] = useState(() => loadPrinterSize());
  const [appUrlTemplate, setAppUrlTemplate] = useState('');
  const [serviceUuid, setServiceUuid] = useState(DEFAULT_SERVICE_UUID);
  const [characteristicUuid, setCharacteristicUuid] = useState(DEFAULT_CHARACTERISTIC_UUID);
  const [device, setDevice] = useState(null);
  const [characteristic, setCharacteristic] = useState(null);
  const [activeProfile, setActiveProfile] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [imageName, setImageName] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [invert, setInvert] = useState(false);
  const imageCanvasRef = useRef(null);
  const originalImageRef = useRef(null);
  const galleryRef = useRef(null);
  const cameraRef = useRef(null);
  const [imageTick, setImageTick] = useState(0);
  const paperDots = printerSize.dots;
  const connected = Boolean(characteristic);
  const activePresetId = useMemo(() => {
    const match = PAPER_PRESETS.find(
      (preset) =>
        preset.paperMm === Number(printerSize.paperMm) &&
        preset.dots === printerSize.dots &&
        preset.dpi === printerSize.dpi,
    );
    return match?.id || 'custom';
  }, [printerSize]);

  const updatePrinterSize = (patch) => {
    setPrinterSize((current) => {
      const next = { ...current, ...patch, id: patch.id || 'custom' };
      next.dpi = Number(next.dpi) === 300 ? 300 : 203;
      next.paperMm = Math.max(1, Math.min(112, Number(next.paperMm) || 58));
      next.dots = normalizeDots(next.dots);
      next.printableMm = mmFromDots(next.dots, next.dpi);
      savePrinterSize(next);
      return next;
    });
  };

  const applyPreset = (preset) => {
    const next = {
      id: preset.id,
      paperMm: preset.paperMm,
      printableMm: preset.printableMm,
      dpi: preset.dpi,
      dots: preset.dots,
    };
    savePrinterSize(next);
    setPrinterSize(next);
  };

  const queueImage = (source, name = 'image') => {
    originalImageRef.current = source;
    setImageName(name);
    setImageTick((value) => value + 1);
    setMode('image');
  };

  useEffect(() => {
    if (!originalImageRef.current) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const image = await loadImageElement(originalImageRef.current);
        if (cancelled) {
          image.close?.();
          return;
        }
        const canvas = ditherCanvas(drawImageToCanvas(image, paperDots), invert);
        image.close?.();
        imageCanvasRef.current = canvas;
        setPreviewUrl(canvasToPreviewUrl(canvas));
        setStatus(`Ready to print ${imageName || 'image'}`);
      } catch (error) {
        setStatus(`Image failed: ${error?.message || error}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperDots, invert, imageTick, imageName]);

  useEffect(() => {
    const onPaste = async (event) => {
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (imageItem) {
        event.preventDefault();
        const file = imageItem.getAsFile();
        if (file) queueImage(file, file.name || 'pasted-image.png');
        return;
      }
      const pasted = event.clipboardData?.getData('text');
      if (pasted && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
        setText((current) => (current ? `${current}\n${pasted}` : pasted));
        setMode('text');
        setStatus('Pasted text is ready to print');
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const connectPrinter = async () => {
    if (!navigator.bluetooth) {
      setStatus('Web Bluetooth is not available. Open this page in Bluefy or Safari with WebBLE.');
      return;
    }

    try {
      setStatus('Choose your BLE thermal printer');
      const profilesToTry = [
        ...PRINTER_PROFILES,
        {
          name: 'Custom UUIDs',
          serviceUuid: serviceUuid.toLowerCase(),
          characteristicUuid: characteristicUuid.toLowerCase(),
        },
      ].filter(
        (profile, index, profiles) =>
          profiles.findIndex(
            (item) => item.serviceUuid === profile.serviceUuid && item.characteristicUuid === profile.characteristicUuid,
          ) === index,
      );
      const selectedDevice = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: profilesToTry.map((profile) => profile.serviceUuid),
      });
      selectedDevice.addEventListener('gattserverdisconnected', () => {
        setCharacteristic(null);
        setStatus(`${selectedDevice.name || 'Printer'} disconnected`);
      });

      setStatus(`Connecting to ${selectedDevice.name || 'printer'}...`);
      const server = await selectedDevice.gatt.connect();
      let matchedProfile;
      let writeCharacteristic;

      for (const profile of profilesToTry) {
        try {
          const service = await server.getPrimaryService(profile.serviceUuid);
          const candidate = await service.getCharacteristic(profile.characteristicUuid);
          if (candidate.properties.write || candidate.properties.writeWithoutResponse) {
            matchedProfile = profile;
            writeCharacteristic = candidate;
            break;
          }
        } catch {
          // Try the next known printer profile.
        }
      }

      if (!writeCharacteristic) throw new Error('No writable characteristic found in the known printer profiles');

      setDevice(selectedDevice);
      setCharacteristic(writeCharacteristic);
      setActiveProfile(matchedProfile.name);
      setServiceUuid(matchedProfile.serviceUuid);
      setCharacteristicUuid(matchedProfile.characteristicUuid);
      setStatus(`Connected to ${selectedDevice.name || 'printer'} via ${matchedProfile.name}`);
    } catch (error) {
      setCharacteristic(null);
      setStatus(`Connection failed: ${error?.message || error}`);
    }
  };

  const disconnectPrinter = async () => {
    try {
      device?.gatt?.disconnect();
    } catch {
      // Some browsers throw if the device is already gone.
    }
    setCharacteristic(null);
    setDevice(null);
    setActiveProfile('');
    setStatus('Printer disconnected');
  };

  const sendCanvas = async (canvas, label) => {
    if (!characteristic) {
      setStatus('Connect a BLE printer first, or use Print via iPhone app.');
      return;
    }
    setIsPrinting(true);
    try {
      setStatus(`Sending ${label} to ${device?.name || 'printer'}...`);
      await printCanvas(characteristic, canvas, {
        onProgress: (sent, total) => {
          const percent = total ? Math.min(99, Math.round((sent / total) * 100)) : 0;
          setStatus(`Printing ${label}… ${percent}%`);
        },
      });
      setStatus('Print job sent');
    } catch (error) {
      setStatus(`Print failed: ${error?.message || error}`);
    } finally {
      setIsPrinting(false);
    }
  };

  const printText = async () => {
    const value = text.trim();
    if (!value) {
      setStatus('Paste or type some text first');
      return;
    }
    await sendCanvas(renderTextCanvas(value, paperDots), 'text');
  };

  const printImage = async () => {
    if (!imageCanvasRef.current) {
      setStatus('Upload or paste an image first');
      return;
    }
    await sendCanvas(imageCanvasRef.current, 'photo');
  };

  const printNow = () => {
    if (mode === 'text') return printText();
    return printImage();
  };

  const printViaApp = async () => {
    if (mode === 'image' && imageCanvasRef.current) {
      const blob = await new Promise((resolve) => imageCanvasRef.current.toBlob(resolve, 'image/png'));
      const file = new File([blob], imageName || 'print.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Thermal print' });
        setStatus('Share sheet opened. Choose Simple Bluetooth Printer.');
        return;
      }
    }

    const payload = text.trim() || ' ';
    if (appUrlTemplate.trim()) {
      const url = appUrlTemplate.includes('{text}')
        ? appUrlTemplate.replaceAll('{text}', encodeURIComponent(payload))
        : appUrlTemplate;
      window.location.assign(url);
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Thermal print', text: payload });
        setStatus('Share sheet opened. Choose Simple Bluetooth Printer.');
      } catch (error) {
        if (error?.name !== 'AbortError') setStatus(`Could not open share sheet: ${error?.message || error}`);
      }
      return;
    }

    await navigator.clipboard.writeText(payload);
    setStatus('Copied. Paste it in Simple Bluetooth Printer and print.');
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    queueImage(file, file.name);
  };

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div>
            <p className="eyebrow">Pocket thermal printer</p>
            <h1>Print notes and photos</h1>
            <p className="lede">Paste text, add a picture, connect the printer, print. Built for iPhone in Bluefy or Safari with WebBLE.</p>
          </div>
          <span className={connected ? 'badge' : 'badge off'}>{connected ? 'Connected' : 'Not connected'}</span>
        </div>
        <p className="status">{status}</p>
        <div className="connect-row">
          <button className="primary" onClick={connectPrinter}>
            {connected ? 'Reconnect' : 'Connect printer'}
          </button>
          {connected ? (
            <button className="danger" onClick={disconnectPrinter}>
              Disconnect
            </button>
          ) : null}
        </div>
        {activeProfile ? <p className="hint">{device?.name || 'Printer'} · {activeProfile} · {paperDots} dots</p> : null}
      </header>

      <section className="card size-card">
        <span className="field-label">Printer size</span>
        <div className="segmented size-presets">
          {PAPER_PRESETS.map((preset) => (
            <button key={preset.id} className={activePresetId === preset.id ? 'active' : ''} onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
          <button className={activePresetId === 'custom' ? 'active' : ''} onClick={() => updatePrinterSize({ id: 'custom' })}>
            Custom
          </button>
        </div>
        <div className="size-grid">
          <label className="field">
            <span className="field-label">Paper width (mm)</span>
            <input
              type="number"
              min="20"
              max="112"
              inputMode="decimal"
              value={printerSize.paperMm}
              onChange={(event) => updatePrinterSize({ paperMm: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Printable (mm)</span>
            <input
              type="number"
              min="16"
              max="104"
              step="0.1"
              inputMode="decimal"
              value={printerSize.printableMm}
              onChange={(event) => {
                const printableMm = Number(event.target.value);
                updatePrinterSize({
                  printableMm,
                  dots: dotsFromMm(printableMm, printerSize.dpi),
                });
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">DPI</span>
            <div className="segmented">
              {[203, 300].map((dpi) => (
                <button
                  key={dpi}
                  type="button"
                  className={printerSize.dpi === dpi ? 'active' : ''}
                  onClick={() => updatePrinterSize({ dpi, dots: dotsFromMm(printerSize.printableMm, dpi) })}
                >
                  {dpi}
                </button>
              ))}
            </div>
          </label>
          <label className="field">
            <span className="field-label">Print dots</span>
            <input
              type="number"
              min="64"
              max="1024"
              step="8"
              inputMode="numeric"
              value={printerSize.dots}
              onChange={(event) => updatePrinterSize({ dots: event.target.value })}
            />
          </label>
        </div>
        <p className="hint">
          Printing at {printerSize.dots} dots on {printerSize.paperMm} mm paper ({printerSize.printableMm} mm printable at {printerSize.dpi} DPI). If the image is cut off, lower dots. If you see a white side margin, raise dots.
        </p>
      </section>

      <div className="segmented" role="tablist">
        <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
          Text
        </button>
        <button className={mode === 'image' ? 'active' : ''} onClick={() => setMode('image')}>
          Photo
        </button>
      </div>

      {mode === 'text' ? (
        <section className="card">
          <label className="field">
            <span className="field-label">Paste or type</span>
            <textarea
              className="receipt"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'Paste anything:\nshop list, a caption, a receipt, a note...'}
            />
          </label>
          <p className="hint">Text is drawn as a bitmap so Malayalam, Arabic, emoji, and mixed scripts print on generic ESC/POS printers.</p>
        </section>
      ) : (
        <section className="card">
          <input ref={galleryRef} className="hidden-input" type="file" accept="image/*" onChange={onFile} />
          <input ref={cameraRef} className="hidden-input" type="file" accept="image/*" capture="environment" onChange={onFile} />
          {previewUrl ? (
            <div className="preview-wrap">
              <img src={previewUrl} alt="Thermal preview" />
            </div>
          ) : (
            <div className="dropzone">
              <strong>No photo yet</strong>
              Take one, pick from the library, or paste an image.
            </div>
          )}
          <div className="actions">
            <button className="primary" onClick={() => cameraRef.current?.click()}>
              Camera
            </button>
            <button className="ghost" onClick={() => galleryRef.current?.click()}>
              Library
            </button>
            <button className={invert ? 'primary' : 'ghost'} onClick={() => setInvert((value) => !value)}>
              {invert ? 'Inverted' : 'Invert'}
            </button>
          </div>
          <p className="hint">Photos are resized to the paper width and dithered so they look right on thermal paper.</p>
        </section>
      )}

      <details className="card advanced">
        <summary>Advanced / iPhone app fallback</summary>
        <label className="field">
          <span className="field-label">Optional app URL template</span>
          <input value={appUrlTemplate} onChange={(event) => setAppUrlTemplate(event.target.value)} placeholder="my-printer://print?text={text}" autoCapitalize="none" />
        </label>
        <label className="field">
          <span className="field-label">BLE service UUID</span>
          <input value={serviceUuid} onChange={(event) => setServiceUuid(event.target.value)} autoCapitalize="none" />
        </label>
        <label className="field">
          <span className="field-label">Writable characteristic UUID</span>
          <input value={characteristicUuid} onChange={(event) => setCharacteristicUuid(event.target.value)} autoCapitalize="none" />
        </label>
      </details>

      <div className="dock">
        <button className="primary" onClick={printNow} disabled={isPrinting}>
          {isPrinting ? 'Printing…' : mode === 'text' ? 'Print text' : 'Print photo'}
        </button>
        <button className="ghost" onClick={printViaApp}>
          iPhone app
        </button>
      </div>
    </main>
  );
}
