"""Extrae el texto de un documento de Office (docx, xlsx, pptx) y lo imprime. Lo corre el usuario "medios"."""
import sys

def docx(ruta):
    import docx as d
    doc = d.Document(ruta)
    partes = [p.text for p in doc.paragraphs if p.text.strip()]
    for t in doc.tables:
        for fila in t.rows:
            partes.append(" | ".join(c.text.strip() for c in fila.cells))
    return "\n".join(partes)

def xlsx(ruta):
    import openpyxl
    libro = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    partes = []
    for hoja in libro.worksheets:
        partes.append(f"## {hoja.title}")
        for i, fila in enumerate(hoja.iter_rows(values_only=True)):
            if i >= 500:
                partes.append("…")
                break
            if any(v is not None for v in fila):
                partes.append(" | ".join("" if v is None else str(v) for v in fila))
    return "\n".join(partes)

def pptx(ruta):
    import pptx as p
    pres = p.Presentation(ruta)
    partes = []
    for n, diapo in enumerate(pres.slides, 1):
        partes.append(f"## Diapositiva {n}")
        for forma in diapo.shapes:
            if forma.has_text_frame and forma.text_frame.text.strip():
                partes.append(forma.text_frame.text)
    return "\n".join(partes)

if __name__ == "__main__":
    tipo, ruta = sys.argv[1], sys.argv[2]
    print({"docx": docx, "xlsx": xlsx, "pptx": pptx}[tipo](ruta)[:200000])
