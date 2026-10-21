"""Generate tiny synthetic images. Tests do not contain anyone's photographs."""
from pathlib import Path
import struct
from PIL import Image,TiffImagePlugin
p=Path(__file__).resolve().parent/'fixtures';p.mkdir(exist_ok=True)
R=TiffImagePlugin.IFDRational
image=Image.new('RGB',(32,24),(88,20,46))
def gps(lat=(29,38,55.87),lon=(82,20,16.4),latref='N',lonref='W',alt=47.46,altref=0):
 d={2:tuple(R(x) for x in lat),4:tuple(R(x) for x in lon)}
 if latref is not None:d[1]=latref
 if lonref is not None:d[3]=lonref
 if alt is not None:d[5]=altref;d[6]=R(alt)
 return d
def metadata(g):
 e=Image.Exif();e[271]='Synthetic Test Camera';e[272]='Fixture 1';e[34853]=g;e[34665]={36867:'2026:10:21 12:34:56',36881:'-04:00'};return e
for name,g in [('gps-north-west.jpg',gps()),('gps-south-east.jpg',gps(latref='S',lonref='E',alt=12.5,altref=1)),('gps-zero-zero.jpg',gps(lat=(0,0,0),lon=(0,0,0),alt=0)),('gps-outside-region.jpg',gps(lat=(48,51,29.52),lon=(2,17,40.2),lonref='E')),('partial-gps.jpg',{1:'N',2:(R(29),R(38),R(55.87))}),('missing-ref.jpg',gps(latref=None)),('invalid-gps.jpg',gps(lat=(91,0,0)))]:image.save(p/name,exif=metadata(g))
image.save(p/'no-gps.jpg');image.save(p/'no-gps.png');image.save(p/'gps.png',exif=metadata(gps()))
tiff_exif=Image.Exif();tiff_exif.load(metadata(gps()).tobytes());image.save(p/'gps.tiff',exif=tiff_exif)
image.save(p/'gps.webp',format='WEBP',exif=metadata(gps()).tobytes());image.save(p/'no-gps.webp',format='WEBP')
(p/'unsupported.bin').write_bytes(b'%PDF-1.7\nnot an image');(p/'corrupt.tiff').write_bytes(b'II*\x00\xff\xff\xff\xff');(p/'empty.jpg').write_bytes(b'')
xmp=b'''<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.492N" exif:GPSLongitude="2,17.670E"/></rdf:RDF></x:xmpmeta>'''
segment=b'http://ns.adobe.com/xap/1.0/\0'+xmp
app1=b'\xff\xe1'+struct.pack('>H',len(segment)+2)+segment
base=(p/'no-gps.jpg').read_bytes();(p/'xmp-gps.jpg').write_bytes(base[:2]+app1+base[2:])
base=(p/'gps-north-west.jpg').read_bytes();(p/'conflicting-gps.jpg').write_bytes(base[:2]+app1+base[2:])
b=bytearray((p/'gps.webp').read_bytes());b[4:8]=struct.pack('<I',len(b)+500);(p/'corrupt.webp').write_bytes(b)
(p/'README.txt').write_text('All images are generated colored rectangles containing synthetic metadata. Coordinates are test values, not the location of a photographed person. Run generate_fixtures.py with Pillow only when regenerating these files. Running the application requires no Python packages.\n')
print('Generated',len(list(p.glob('*'))),'fixture files.')
