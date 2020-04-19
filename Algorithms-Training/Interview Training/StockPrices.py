#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Jan 21 12:16:47 2020

@author: fraifeld-mba
"""

import random
import sys

stock_prices = [random.randint(1,50) for x in range(50)]
def get_buy_sell(s):
    profit = -sys.maxsize
    min_price = sys.maxsize
    min_price_index = 0
    for i in range(len(s)):
        
        # Calculate the potential profit from selling at this moment
        # Note that the min price here is the min price of the examined subarray
        current_price = s[i]
        potential_profit = current_price - min_price
        
        # Since the min price has not yet changes this iteration, the only way potential profit increases
        # is if the max price has moved up. 
        # Here we should lock in the sale for our records
        # It is possible that we will find lower stock prices in the later parts of the array
        # But we may not use them to engage in sales (lower available revenue), so we make note of the index of the min price we used.
        
        if potential_profit > profit:
            max_price_index = i
            profit = potential_profit
            min_price_used_index = min_price_index
            
            
        # The revenue calculation at the top requires us to be always updated on the minimum prices available
        
        if s[i]<min_price:
            min_price = s[i]
            min_price_index = i
                
            
    return {"buy_at":(s[min_price_used_index],min_price_used_index),"sell_at":(s[max_price_index],max_price_index),"revenue":profit}
        
        