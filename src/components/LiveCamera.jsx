// src/components/LiveCamera.jsx
import { useState, useEffect, useRef } from 'react';

export default function LiveCamera({ onCapture }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' } // back camera for measurements
        });
        videoRef.current.srcObject = mediaStream;
        setStream(mediaStream);
      } catch (err) {
        console.error('Camera access denied:', err);
      }
    };

    startCamera();
    return () => {
      if (stream) stream.getTracks().forEach(track => track.stop());
    };
  }, []);

  const captureImage = () => {
    const context = canvasRef.current.getContext('2d');
    context.drawImage(videoRef.current, 0, 0, 640, 480);
    canvasRef.current.toBlob(blob => {
      onCapture(blob);
    }, 'image/jpeg');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        style={{ width: '100%', borderRadius: 8 }}
      />
      <canvas 
        ref={canvasRef} 
        width={640} 
        height={480} 
        style={{ display: 'none' }}
      />
      <button 
        onClick={captureImage}
        style={{
          padding: '8px 16px',
          background: '#f59e0b',
          color: '#000',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
          fontWeight: 500
        }}
      >
        📸 Capture & Measure
      </button>
    </div>
  );
}