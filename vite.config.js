import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Shared self-signed cert (see certs/) also used by the backend on :3001 —
// both need HTTPS since browsers block camera access (getUserMedia) and
// mixed-content API calls from a non-localhost origin unless it's secure.
const certDir = path.resolve(__dirname, 'certs')

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    https: {
      key:  fs.readFileSync(path.join(certDir, 'key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    },
  },
})
