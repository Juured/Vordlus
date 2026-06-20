'use client';

import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';

export default function PropertyMap() {
  return (
    <div className="h-[500px] w-full rounded-lg border bg-white p-0 overflow-hidden">
      <MapContainer
        center={[59.437, 24.7536]}
        zoom={14}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <Marker position={[59.437, 24.7536]}>
          <Popup>Valitud asukoht</Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
