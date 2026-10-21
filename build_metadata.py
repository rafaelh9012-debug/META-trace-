"""Build the offline metadata app with Python's standard library."""
from pathlib import Path
import hashlib,json,re
ROOT=Path(__file__).resolve().parent

def read(name):return (ROOT/name).read_text(encoding='utf-8')
def js_json(value):return json.dumps(value,ensure_ascii=True,separators=(',',':')).replace('<','\\u003c')
def main():
 data='\n'.join('window.'+var+'='+js_json(json.loads(read(path)))+';' for var,path in [('TRACE_MAP_DATA','data/map-data.json'),('TRACE_MAP_LABELS','data/map-labels.json'),('TRACE_MAP_META','data/map-meta.json'),('TRACE_WORLD_DATA','data/world-data.json'),('TRACE_WORLD_LABELS','data/world-labels.json')])
 exifr=re.sub(r'\n?//# sourceMappingURL=.*','',read('vendor/exifr-7.1.3.umd.js'))
 worker='\n'.join([exifr,read('metadata-core.js'),read('metadata-parser.js'),read('metadata-worker.js')])
 replacements={'/*__LEAFLET_CSS__*/':read('vendor/leaflet.css'),'/*__METADATA_CSS__*/':read('metadata-styles.css'),'/*__LEAFLET_JS__*/':read('vendor/leaflet.js'),'/*__EXIFR_JS__*/':exifr,'/*__MAP_DATA__*/':data,'/*__METADATA_CORE__*/':read('metadata-core.js'),'/*__METADATA_PARSER__*/':read('metadata-parser.js'),'/*__WORKER_SOURCE__*/':'window.METADATA_WORKER_SOURCE='+js_json(worker)+';','/*__MAP_UTILS__*/':read('map-utils.js'),'/*__METADATA_APP__*/':read('metadata-app.js')}
 html=read('metadata-template.html')
 for token,value in replacements.items():html=html.replace(token,value)
 assert not re.search(r'/\*__\w+__\*/',html)
 assert 'api.maptiler.com' not in html and './init-model' not in html
 (ROOT/'Qwen_Map_Console.html').write_text(html,encoding='utf-8')
 (ROOT/'BUILD_INFO.json').write_text(json.dumps({'application':'Crimson Image Metadata','version':'2.0.0','dependency':'exifr 7.1.3','parserSha256':hashlib.sha256((ROOT/'vendor/exifr-7.1.3.umd.js').read_bytes()).hexdigest(),'htmlSha256':hashlib.sha256(html.encode()).hexdigest(),'htmlBytes':len(html.encode())},indent=2)+'\n')
 print('Built real metadata app:',len(html.encode()),'bytes')
if __name__=='__main__':main()
