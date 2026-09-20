# Thermal Printer Lab

Sample React + Vite app for testing thermal printer workflows from iPhone.

## What it includes

- Method 1: Simple Bluetooth Printer app handoff
- Method 2: Bluefy browser flow for BLE/Web Bluetooth printers
- Sample receipt content and placeholder ESC/POS preview

## Run locally

```bash
npm install
npm run dev
```

## Notes

- Replace `printertest://` with the actual deep link or custom scheme your printer app expects.
- Bluefy support depends on the printer model and the GATT services/characteristics it exposes.
- iPhone Safari generally does not provide arbitrary Bluetooth printing support, so a browser like Bluefy is usually required for BLE browser access.
