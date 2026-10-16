export const CATEGORIES = ['superior', 'inferior', 'vestido', 'abrigo', 'calzado', 'bolso', 'accesorio'] as const;
export const OCCASIONS = ['trabajo', 'cita', 'evento', 'noche', 'casual'] as const;
export const categoryLabels: Record<string, string> = { superior: 'Prendas superiores', inferior: 'Pantalones y faldas', vestido: 'Vestidos', abrigo: 'Abrigos', calzado: 'Calzado', bolso: 'Bolsos', accesorio: 'Accesorios' };
export const occasionLabels: Record<string, string> = { trabajo: 'Trabajo', cita: 'Cita', evento: 'Evento especial', noche: 'Salida nocturna', casual: 'Casual' };
