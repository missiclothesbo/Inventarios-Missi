-- 003_reportes_y_rls.sql
-- Requiere 001 y 002. Agrega la funcion de balances y RLS de las tablas NUEVAS.
begin;

------------------------------------------------------------------ RLS tablas nuevas
-- Lectura abierta al rol de la app; ninguna escritura directa: se escribe solo por RPC.
do $$
declare t text;
begin
  foreach t in array array['sucursales','movimientos_inventario','traspasos','traspaso_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)',
                   t || '_select', t);
  end loop;
end $$;

------------------------------------------------------------------ balances
-- Ingresos = suma de ventas.total (una vez por venta) de ventas NO canceladas.
-- Las unidades/productos salen de detalle_venta en consultas aparte, para no multiplicar el total.
-- Los traspasos se informan en su propia seccion y nunca suman a ingresos.
create or replace function public.balance_ventas(
  p_desde date, p_hasta date,
  p_sucursal bigint default null, p_metodo text default null,
  p_departamento text default null, p_modalidad text default null)
returns jsonb language sql stable security definer set search_path = public as $$
with rango as (
  select (p_desde::timestamp at time zone 'America/La_Paz') as d,
         ((p_hasta + 1)::timestamp at time zone 'America/La_Paz') as h
), v as (
  select ventas.* from public.ventas, rango
   where estado = 'completada'
     and (p_desde is null or fecha >= rango.d)
     and (p_hasta is null or fecha <  rango.h)
     and (p_sucursal is null or sucursal_id = p_sucursal)
     and (p_metodo is null or metodo_pago = p_metodo)
     and (p_departamento is null or departamento = p_departamento)
     and (p_modalidad is null or modalidad = p_modalidad)
), u as (
  select d.venta_id, sum(d.cantidad) as unidades
    from public.detalle_venta d join v on v.id = d.venta_id group by d.venta_id
), tr as (
  select t.* from public.traspasos t, rango
   where (p_desde is null or t.fecha >= rango.d)
     and (p_hasta is null or t.fecha <  rango.h)
     and (p_sucursal is null or t.origen_id = p_sucursal or t.destino_id = p_sucursal)
)
select jsonb_build_object(
  'resumen', (select jsonb_build_object(
      'ventas', count(*), 'ingresos', coalesce(sum(v.total),0),
      'unidades', coalesce((select sum(unidades) from u),0)) from v),
  'por_metodo', coalesce((select jsonb_agg(x order by x->>'clave') from (
      select jsonb_build_object('clave', coalesce(metodo_pago,'Sin registrar'),
             'ventas', count(*), 'ingresos', sum(total)) x from v group by metodo_pago) s), '[]'),
  'por_sucursal', coalesce((select jsonb_agg(x order by x->>'clave') from (
      select jsonb_build_object('clave', s.nombre, 'ventas', count(*), 'ingresos', sum(v.total)) x
        from v join public.sucursales s on s.id = v.sucursal_id group by s.nombre) q), '[]'),
  'por_departamento', coalesce((select jsonb_agg(x order by x->>'clave') from (
      select jsonb_build_object('clave', coalesce(departamento,'Entrega directa / sin destino'),
             'ventas', count(*), 'ingresos', sum(total)) x from v group by departamento) s), '[]'),
  'por_modalidad', coalesce((select jsonb_agg(x order by x->>'clave') from (
      select jsonb_build_object('clave', coalesce(modalidad,'Sin registrar'),
             'ventas', count(*), 'ingresos', sum(total)) x from v group by modalidad) s), '[]'),
  'por_dia', coalesce((select jsonb_agg(x order by x->>'clave') from (
      select jsonb_build_object('clave', to_char(fecha at time zone 'America/La_Paz','YYYY-MM-DD'),
             'ventas', count(*), 'ingresos', sum(total)) x
        from v group by to_char(fecha at time zone 'America/La_Paz','YYYY-MM-DD')) s), '[]'),
  'top_productos', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('producto', p.nombre, 'unidades', sum(d.cantidad),
             'ingresos', sum(d.subtotal)) x
        from public.detalle_venta d join v on v.id = d.venta_id
        join public.productos p on p.id = d.producto_id
       group by p.nombre order by sum(d.cantidad) desc, sum(d.subtotal) desc limit 10) s), '[]'),
  'traspasos', (select jsonb_build_object(
      'total', count(*),
      'pendientes', count(*) filter (where estado = 'pendiente'),
      'enviados',   count(*) filter (where estado = 'enviado'),
      'recibidos',  count(*) filter (where estado = 'recibido'),
      'cancelados', count(*) filter (where estado = 'cancelado'),
      'unidades_recibidas', coalesce((select sum(i.cantidad) from public.traspaso_items i
                                       join tr t2 on t2.id = i.traspaso_id
                                      where t2.estado = 'recibido'),0)) from tr)
);
$$;
grant execute on function public.balance_ventas(date,date,bigint,text,text,text) to anon, authenticated;

commit;
