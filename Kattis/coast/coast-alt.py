#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed May 29 09:55:16 2019

@author: fraifeld-mba
"""

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May 20 19:07:52 2019

@author: fraifeld-mba
"""

import sys
import collections


def water(a,mx,n,m):
    if min(a) < 0:
        return False
    if a[1] >= m:
        return False
    if a[0] >= n:
        return False
    if mx[a[0]][a[1]]  == '0':
        return True
    return False
    
    
    
def water_neighbors(mx,i,j,n,m):
   return set( x for x in 
            [(i-1,j),
            (i+1,j),
            (i, j-1),
            (i,j +1)] if water(x,mx,n,m)
            )
   

def land(i,j,mx,n,m):
    if i < 0 or j < 0:
        return False
    if j >= m:
        return False
    if i >= n:
        return False
    if mx[i][j]  == '1':
        return True
    return False
    

def land_neighbors(mx, i, j,n,m):
    s = 0
    for x in [[i-1,j],
            [i+1,j],
            [i, j-1],
            [i,j +1]]:
        s = s + land(x[0],x[1],mx,n,m)
    return s
            
def cut_mx(mx,n,m):
    top = 0
    bottom = n

    for i in range(n-1):
        if "1" in mx[i+1]:
            top = i
            break
    for i in range(n,1,-1):
        if "1" in mx[i-1]:
            bottom = i+1
            break
    return mx[top:bottom]



def bfs_coast(mx,n,m):
    mx = cut_mx(mx,n,m)
    n = len(mx)
    coast = 0
    visited = set([(0,0)])
    queue = collections.deque()
    queue.appendleft([0,0])
    while len(queue) > 0:
        # dequeue
        v = queue.popleft()

        # since we are now examining/processing v, we add its land coastline
        coast = coast+land_neighbors(mx,v[0],v[1],n,m)
        
        # add each neighbor to the queue, so that we pull them out in breadth order
        ne = water_neighbors(mx,v[0],v[1],n,m)

        for w in ne:
            if (w[0],w[1]) not in visited:
                visited.add((w[0],w[1]))
                queue.appendleft(w)
            


    return coast

i = 0
for line in sys.stdin:
        if i == 0:
            line = line.split(" ")
            n = int(line[0]) + 2
            m = int(line[1]) + 2
            i = 1
            mx = ["0" * m]
    
        else:
            #line = line.replace("\n","")
            mx.append("0"+line.replace("\n","")+"0")
    
mx.append("0" * m)


sys.stdout.write(str(bfs_coast(mx,n,m))+"\n")




